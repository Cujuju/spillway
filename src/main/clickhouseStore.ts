import { createHash } from 'node:crypto';
import { CLICKHOUSE_BATCH_BYTES, CLICKHOUSE_BATCH_ROWS, CLICKHOUSE_OUTBOX_BYTES, DEFAULT_CLICKHOUSE_CONFIG, validateClickHouseConfig, type ClickHouseBatch, type ClickHouseConfig, type ClickHouseStatus } from '@shared/clickhouse';
import type { Db } from './activityDb';
import type { ArchiveFact, ArchiveFactSink, ArchiveStore } from './archiveStore';
import { encodeClickHouseLine, outboxBytes, type OutboxRow } from './clickhouseLine';

const RETRY_INITIAL_MS = 1_000, RETRY_MAX_MS = 300_000, RETRY_MAX_EXPONENT = 9;
const RETRY_JITTER_FRACTION = 0.5;
export const CLICKHOUSE_SCHEMA = `
DROP TABLE IF EXISTS clickhouse_batch; DROP TABLE IF EXISTS clickhouse_queue; DROP TABLE IF EXISTS clickhouse_state;
CREATE TABLE IF NOT EXISTS clickhouse_export (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), source_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
 config TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_CLICKHOUSE_CONFIG)}', acknowledged INTEGER NOT NULL DEFAULT 0,
 discarded INTEGER NOT NULL DEFAULT 0, oversized INTEGER NOT NULL DEFAULT 0, last_ack TEXT, error TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, backfill_cursor TEXT,
 queued_rows INTEGER NOT NULL DEFAULT 0, queued_bytes INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO clickhouse_export(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS clickhouse_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, trace_id TEXT NOT NULL, at TEXT NOT NULL,
 capture_state TEXT NOT NULL, record TEXT NOT NULL, content TEXT, bytes INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS clickhouse_outbox_insert AFTER INSERT ON clickhouse_outbox BEGIN
 UPDATE clickhouse_export SET queued_rows=queued_rows+1,queued_bytes=queued_bytes+NEW.bytes;
END;
CREATE TRIGGER IF NOT EXISTS clickhouse_outbox_delete AFTER DELETE ON clickhouse_outbox BEGIN
 UPDATE clickhouse_export SET queued_rows=queued_rows-1,queued_bytes=queued_bytes-OLD.bytes;
END;`;
export const clickhouseDestination = (c: ClickHouseConfig): string => createHash('sha256').update(JSON.stringify([c.endpoint, c.database, c.table])).digest('hex');
type State = { source_id: string; config: string; acknowledged: number; discarded: number; oversized: number; last_ack: string | null; error: string | null; attempts: number; next_attempt: number; backfill_cursor: string | null };

export class ClickHouseStore implements ArchiveFactSink {
  constructor(private db: Db, private archive: ArchiveStore) {}
  private state(): State { return this.db.prepare('SELECT * FROM clickhouse_export').get() as State; }
  config(): ClickHouseConfig { return validateClickHouseConfig(JSON.parse(this.state().config)); }
  private totals(): { n: number; bytes: number } { return this.db.prepare('SELECT queued_rows AS n,queued_bytes AS bytes FROM clickhouse_export').get() as { n: number; bytes: number }; }
  configure(raw: ClickHouseConfig): void {
    const next = validateClickHouseConfig(raw), prev = this.config();
    this.db.transaction(() => {
      const changed = clickhouseDestination(next) !== clickhouseDestination(prev);
      if (changed && this.totals().n) throw new Error('Clear the upload queue before changing destination');
      this.db.prepare('UPDATE clickhouse_export SET config=?,error=NULL').run(JSON.stringify(next));
      if (next.enabled && (!prev.enabled || changed || !prev.includeBodies && next.includeBodies)) this.db.prepare('UPDATE clickhouse_export SET backfill_cursor=?').run(JSON.stringify(['', '']));
    })();
  }
  append(fact: ArchiveFact): void {
    const config = this.config();
    if (!config.enabled) return;
    this.db.transaction(() => {
      const record = JSON.stringify(fact.record), content = fact.content === null ? null : JSON.stringify(fact.content);
      const row: OutboxRow = { seq: Number.MAX_SAFE_INTEGER, kind: fact.kind, trace_id: fact.traceId, at: fact.at, capture_state: fact.captureState, record, content: null };
      if (!Number.isFinite(Date.parse(fact.at))) { this.db.exec('UPDATE clickhouse_export SET discarded=discarded+1'); return; }
      if (Buffer.byteLength(encodeClickHouseLine(row, config, this.state().source_id, false)) > CLICKHOUSE_BATCH_BYTES) {
        this.db.exec('UPDATE clickhouse_export SET discarded=discarded+1,oversized=oversized+1'); return;
      }
      const bytes = outboxBytes({ ...row, content });
      this.db.prepare('INSERT INTO clickhouse_outbox(kind,trace_id,at,capture_state,record,content,bytes) VALUES(?,?,?,?,?,?,?)').run(fact.kind, fact.traceId, fact.at, fact.captureState, record, content, bytes);
      let total = this.totals().bytes, discarded = 0;
      while (total > CLICKHOUSE_OUTBOX_BYTES) {
        const oldest = this.db.prepare('SELECT seq,bytes FROM clickhouse_outbox ORDER BY seq LIMIT 1').get() as { seq: number; bytes: number };
        this.db.prepare('DELETE FROM clickhouse_outbox WHERE seq=?').run(oldest.seq); total -= oldest.bytes; discarded++;
      }
      if (discarded) this.db.prepare('UPDATE clickhouse_export SET discarded=discarded+?').run(discarded);
    })();
  }
  private backfill(): void {
    let cursor = this.state().backfill_cursor, appended = 0, snapshots = 0;
    while (cursor !== null && snapshots < CLICKHOUSE_BATCH_ROWS && appended < CLICKHOUSE_BATCH_BYTES && this.totals().bytes < CLICKHOUSE_OUTBOX_BYTES) {
      const [at, id] = JSON.parse(cursor) as [string, string];
      const row = this.db.prepare('SELECT id,at,trace_id FROM archive_entries WHERE (at,id)>(?,?) ORDER BY at,id LIMIT 1').get(at, id) as { id: string; at: string; trace_id: string } | undefined;
      if (!row) { this.db.exec('UPDATE clickhouse_export SET backfill_cursor=NULL'); break; }
      const detail = this.archive.detail(row.trace_id);
      if (detail) {
        const { request, response, frames, ...record } = detail;
        const content = request || response || frames.length ? { request, response, frames } : null;
        const size = outboxBytes({ kind: 'snapshot', trace_id: row.trace_id, at: row.at, capture_state: detail.state, record: JSON.stringify(record), content: content === null ? null : JSON.stringify(content) });
        if (appended && appended + size > CLICKHOUSE_BATCH_BYTES) break;
        if (this.totals().bytes + size > CLICKHOUSE_OUTBOX_BYTES) break;
        this.append({ kind: 'snapshot', traceId: row.trace_id, at: row.at, captureState: detail.state, record, content }); appended += size; snapshots++;
      }
      cursor = JSON.stringify([row.at, row.id]);
      this.db.prepare('UPDATE clickhouse_export SET backfill_cursor=?').run(cursor);
    }
  }
  prepare(): ClickHouseBatch | null {
    if (!this.config().enabled || this.state().next_attempt > Date.now()) return null;
    return this.db.transaction(() => {
      this.archive.prune(); this.backfill();
      const config = this.config(), state = this.state();
      const captureBodies = this.archive.status().policy.captureBodies;
      const content = config.includeBodies && captureBodies ? 'content' : 'NULL AS content';
      const pending = this.db.prepare(`SELECT seq,kind,trace_id,at,capture_state,record,${content} FROM clickhouse_outbox ORDER BY seq LIMIT ?`).iterate(CLICKHOUSE_BATCH_ROWS) as IterableIterator<OutboxRow>;
      const oversized: number[] = [];
      let payload = '', bytes = 0, rows = 0, last = 0;
      for (const r of pending) {
        const line = encodeClickHouseLine(r, config, state.source_id, captureBodies), size = Buffer.byteLength(line);
        if (!rows && size > CLICKHOUSE_BATCH_BYTES) {
          oversized.push(r.seq);
          continue;
        }
        if (bytes + size > CLICKHOUSE_BATCH_BYTES) break;
        payload += line; bytes += size; rows++; last = r.seq;
        if (bytes === CLICKHOUSE_BATCH_BYTES) break;
      }
      for (const seq of oversized) this.db.prepare('DELETE FROM clickhouse_outbox WHERE seq=?').run(seq);
      if (oversized.length) this.db.prepare('UPDATE clickhouse_export SET discarded=discarded+?,oversized=oversized+?').run(oversized.length, oversized.length);
      if (!rows) return null;
      const destination = clickhouseDestination(config);
      return { token: `${destination}:${last}`, destination, payload, rows, attempts: state.attempts, nextAttemptAt: state.next_attempt };
    })();
  }
  acknowledge(token: string, destination: string): void {
    const [fingerprint, rawSeq] = token.split(':'), seq = Number(rawSeq);
    if (fingerprint !== destination || destination !== clickhouseDestination(this.config()) || !Number.isSafeInteger(seq) || seq < 1) return;
    this.db.transaction(() => {
      const deleted = this.db.prepare('DELETE FROM clickhouse_outbox WHERE seq<=?').run(seq).changes;
      this.db.prepare('UPDATE clickhouse_export SET acknowledged=acknowledged+?,last_ack=?,error=NULL,attempts=0,next_attempt=0').run(deleted, new Date().toISOString());
    })();
  }
  fail(token: string, now: number, error: string): void {
    if (!token.startsWith(`${clickhouseDestination(this.config())}:`)) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(this.state().attempts, RETRY_MAX_EXPONENT));
    this.db.prepare('UPDATE clickhouse_export SET attempts=attempts+1,next_attempt=?,error=?').run(now + delay * (1 - RETRY_JITTER_FRACTION * Math.random()), error.slice(0, 256));
  }
  retry(): void { this.db.exec('UPDATE clickhouse_export SET next_attempt=0'); }
  clear(): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE clickhouse_export SET discarded=discarded+?,error=NULL,backfill_cursor=NULL').run(this.totals().n);
      this.db.exec('DELETE FROM clickhouse_outbox');
    })();
  }
  status(): Omit<ClickHouseStatus, 'hasCredentials' | 'running' | 'paused'> {
    const r = this.state(), totals = this.totals();
    const oldest = this.db.prepare('SELECT at FROM clickhouse_outbox ORDER BY seq LIMIT 1').get() as { at: string } | undefined;
    return { config: this.config(), queued: totals.n, queuedBytes: totals.bytes, oldestQueuedAt: oldest?.at ?? null, acknowledged: r.acknowledged, discarded: r.discarded, oversized: r.oversized, attempts: r.attempts, nextAttemptAt: r.next_attempt, lastAcknowledgedAt: r.last_ack, error: r.error, backfilling: r.backfill_cursor !== null };
  }
}
