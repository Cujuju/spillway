import { createHash } from 'node:crypto';
import { CLICKHOUSE_BATCH_BYTES, CLICKHOUSE_BATCH_ROWS, CLICKHOUSE_QUEUE_LIMIT, DEFAULT_CLICKHOUSE_CONFIG, validateClickHouseConfig, type ClickHouseBatch, type ClickHouseConfig, type ClickHouseStatus } from '@shared/clickhouse';
import type { Db } from './activityDb';
import type { ArchiveStore } from './archiveStore';

const enabled = "coalesce(json_extract((SELECT config FROM clickhouse_state WHERE singleton=1),'$.enabled'),0)=1";
const RETRY_INITIAL_MS = 1_000, RETRY_MAX_MS = 300_000, RETRY_MAX_EXPONENT = 9;
const boundQueue = `UPDATE clickhouse_state SET discarded=discarded+(SELECT count(*) FROM clickhouse_queue)-${CLICKHOUSE_QUEUE_LIMIT} WHERE (SELECT count(*) FROM clickhouse_queue)>${CLICKHOUSE_QUEUE_LIMIT};
DELETE FROM clickhouse_queue WHERE revision IN (SELECT revision FROM clickhouse_queue ORDER BY revision LIMIT max(0,(SELECT count(*) FROM clickhouse_queue)-${CLICKHOUSE_QUEUE_LIMIT}));`;
const enqueue = (id: string) => `DELETE FROM clickhouse_queue WHERE id=${id} AND ${enabled}; INSERT INTO clickhouse_queue(id,queued_at) SELECT ${id},strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${enabled}; ${boundQueue}`;
const invalidate = (id: string) => `DELETE FROM clickhouse_batch WHERE EXISTS (SELECT 1 FROM json_each(revisions) WHERE json_extract(value,'$.id')=${id});`;
const policyChanged = `DELETE FROM clickhouse_batch;
DELETE FROM clickhouse_queue WHERE id IN (SELECT id FROM archive_entries WHERE bytes>0) AND ${enabled};
INSERT INTO clickhouse_queue(id,queued_at) SELECT id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM archive_entries WHERE bytes>0 AND ${enabled}; ${boundQueue}`;
const uploadsContent = "coalesce(json_extract((SELECT config FROM clickhouse_state WHERE singleton=1),'$.includeBodies'),0)=1";
export const CLICKHOUSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS clickhouse_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), source_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
 config TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_CLICKHOUSE_CONFIG)}', acknowledged INTEGER NOT NULL DEFAULT 0,
 discarded INTEGER NOT NULL DEFAULT 0, oversized INTEGER NOT NULL DEFAULT 0, last_ack TEXT, error TEXT
);
INSERT OR IGNORE INTO clickhouse_state(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS clickhouse_queue (revision INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, queued_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clickhouse_batch (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, destination TEXT NOT NULL, payload TEXT NOT NULL, revisions TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0);
DROP TRIGGER IF EXISTS clickhouse_insert; DROP TRIGGER IF EXISTS clickhouse_update; DROP TRIGGER IF EXISTS clickhouse_expire;
DROP TRIGGER IF EXISTS clickhouse_delete; DROP TRIGGER IF EXISTS clickhouse_attempt; DROP TRIGGER IF EXISTS clickhouse_attempt_update;
DROP TRIGGER IF EXISTS clickhouse_policy; DROP TRIGGER IF EXISTS clickhouse_policy_update;
CREATE TRIGGER clickhouse_insert AFTER INSERT ON archive_entries WHEN ${enabled} BEGIN ${enqueue('new.id')} END;
CREATE TRIGGER clickhouse_update AFTER UPDATE ON archive_entries
WHEN ${enabled} AND (new.state IS NOT old.state OR new.reason IS NOT old.reason OR new.detail IS NOT old.detail OR new.session_id IS NOT old.session_id OR new.model IS NOT old.model OR new.provider IS NOT old.provider OR new.client IS NOT old.client OR new.capture_sequence IS NOT old.capture_sequence OR new.capture_epoch IS NOT old.capture_epoch OR new.status IS NOT old.status OR new.at IS NOT old.at OR new.capture_id IS NOT old.capture_id OR new.method IS NOT old.method OR new.path IS NOT old.path OR new.bytes IS NOT old.bytes)
BEGIN ${enqueue('new.id')} END;
CREATE TRIGGER clickhouse_expire AFTER UPDATE ON archive_entries WHEN old.bytes>0 AND new.bytes=0 BEGIN ${invalidate('new.id')} END;
CREATE TRIGGER clickhouse_delete AFTER DELETE ON archive_entries BEGIN
 DELETE FROM clickhouse_queue WHERE id=old.id; ${invalidate('old.id')} END;
CREATE TRIGGER clickhouse_attempt AFTER INSERT ON archive_attempts WHEN ${enabled} BEGIN ${enqueue("'trace:' || new.trace_id")} END;
CREATE TRIGGER clickhouse_attempt_update AFTER UPDATE ON archive_attempts WHEN ${enabled} AND new.detail IS NOT old.detail BEGIN ${enqueue("'trace:' || new.trace_id")} END;
CREATE TRIGGER clickhouse_policy AFTER INSERT ON archive_meta WHEN new.key='policy' AND ${uploadsContent} AND coalesce(json_extract(new.value,'$.captureBodies'),0)<>0 BEGIN ${policyChanged} END;
CREATE TRIGGER clickhouse_policy_update AFTER UPDATE ON archive_meta WHEN new.key='policy' AND ${uploadsContent} AND coalesce(json_extract(new.value,'$.captureBodies'),0) IS NOT coalesce(json_extract(old.value,'$.captureBodies'),0) BEGIN ${policyChanged} END;
`;
export const clickhouseDestination = (c: ClickHouseConfig): string => createHash('sha256').update(JSON.stringify([c.endpoint, c.database, c.table])).digest('hex');

/** References follow source retention; only one encrypted, bounded batch freezes payloads for retry. */
export class ClickHouseStore {
  constructor(private db: Db, private archive: ArchiveStore) {}
  config(): ClickHouseConfig { return JSON.parse((this.db.prepare('SELECT config FROM clickhouse_state').get() as { config: string }).config); }
  configure(raw: ClickHouseConfig): void {
    const next = validateClickHouseConfig(raw), prev = this.config();
    this.db.transaction(() => {
      const destinationChanged = next.endpoint !== prev.endpoint || next.database !== prev.database || next.table !== prev.table;
      if (destinationChanged && (this.count() || this.batch())) throw new Error('Clear the upload queue before changing destination');
      this.db.prepare('UPDATE clickhouse_state SET config=?,error=NULL').run(JSON.stringify(next));
      if (next.includeBodies !== prev.includeBodies) this.db.exec('DELETE FROM clickhouse_batch');
      if (next.enabled && (!prev.enabled || next.includeBodies !== prev.includeBodies || destinationChanged)) {
        this.db.exec("INSERT OR REPLACE INTO clickhouse_queue(id,queued_at) SELECT id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM archive_entries ORDER BY at,id");
      }
      this.bound();
    })();
  }
  private count(): number { return (this.db.prepare('SELECT count(*) AS n FROM clickhouse_queue').get() as { n: number }).n; }
  private bound(): void {
    const excess = this.count() - CLICKHOUSE_QUEUE_LIMIT;
    if (excess <= 0) return;
    this.db.prepare('DELETE FROM clickhouse_queue WHERE revision IN (SELECT revision FROM clickhouse_queue ORDER BY revision LIMIT ?)').run(excess);
    this.db.prepare('UPDATE clickhouse_state SET discarded=discarded+?').run(excess);
  }
  batch(): ClickHouseBatch | null {
    const r = this.db.prepare('SELECT * FROM clickhouse_batch').get() as { token: string; destination: string; payload: string; revisions: string; attempts: number; next_attempt: number } | undefined;
    return r ? { token: r.token, destination: r.destination, payload: r.payload, rows: JSON.parse(r.revisions), attempts: r.attempts, nextAttemptAt: r.next_attempt } : null;
  }
  prepare(): ClickHouseBatch | null {
    if (!this.config().enabled) return null;
    this.archive.prune(); this.bound();
    if (this.batch()) return this.batch();
    return this.db.transaction(() => {
      const config = this.config();
      const source = (this.db.prepare('SELECT source_id FROM clickhouse_state').get() as { source_id: string }).source_id;
      const pending = this.db.prepare('SELECT id,revision FROM clickhouse_queue ORDER BY revision LIMIT ?').all(CLICKHOUSE_BATCH_ROWS) as { id: string; revision: number }[];
      const rows: ClickHouseBatch['rows'] = []; let payload = '', bytes = 0;
      for (const r of pending) {
        const detail = this.archive.detail(r.id.slice(6));
        if (!detail) { this.db.prepare('DELETE FROM clickhouse_queue WHERE id=?').run(r.id); continue; }
        const { request, response, frames, requestType, responseType, requestEncoding, responseEncoding, requestDecoded, responseDecoded, format, attempts, ...metadata } = detail;
        const include = config.includeBodies && this.archive.status().policy.captureBodies && detail.bytes > 0;
        let record: object = include ? detail : { ...metadata, attempts };
        let policy = include ? 'included' : config.includeBodies ? 'source-unavailable' : 'metadata-only';
        const encode = () => JSON.stringify({ schema_version: 1, source_id: source, id: r.id, revision: r.revision, trace_id: detail.traceId, at: detail.at, capture_state: detail.state, content_policy: policy, record_json: JSON.stringify(record) }) + '\n';
        let line = encode();
        if (Buffer.byteLength(line) > CLICKHOUSE_BATCH_BYTES) { policy = 'omitted-size-limit'; record = { ...metadata, attempts }; line = encode(); }
        const size = Buffer.byteLength(line);
        if (size > CLICKHOUSE_BATCH_BYTES) {
          this.db.prepare('DELETE FROM clickhouse_queue WHERE id=? AND revision=?').run(r.id, r.revision);
          this.db.exec('UPDATE clickhouse_state SET discarded=discarded+1,oversized=oversized+1');
          continue;
        }
        if (bytes + size > CLICKHOUSE_BATCH_BYTES) break;
        payload += line; bytes += size; rows.push(r);
      }
      if (!rows.length) return null;
      const destination = clickhouseDestination(config);
      const token = createHash('sha256').update(destination).update(payload).digest('hex');
      this.db.prepare('INSERT INTO clickhouse_batch(singleton,token,destination,payload,revisions) VALUES(1,?,?,?,?)').run(token, destination, payload, JSON.stringify(rows));
      return this.batch();
    })();
  }
  acknowledge(token: string, destination: string): void {
    this.db.transaction(() => {
      const b = this.batch(); if (!b || b.token !== token || b.destination !== destination || destination !== clickhouseDestination(this.config())) return;
      for (const r of b.rows) this.db.prepare('DELETE FROM clickhouse_queue WHERE id=? AND revision=?').run(r.id, r.revision);
      this.db.prepare('UPDATE clickhouse_state SET acknowledged=acknowledged+?,last_ack=?,error=NULL').run(b.rows.length, new Date().toISOString());
      this.db.exec('DELETE FROM clickhouse_batch');
    })();
  }
  fail(token: string, now: number, error: string): void {
    const b = this.batch(); if (!b || b.token !== token) return;
    this.db.transaction(() => {
      this.db.prepare('UPDATE clickhouse_batch SET attempts=attempts+1,next_attempt=?').run(now + Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(b.attempts, RETRY_MAX_EXPONENT)));
      this.db.prepare('UPDATE clickhouse_state SET error=?').run(error.slice(0, 256));
    })();
  }
  retry(): void { this.db.exec('UPDATE clickhouse_batch SET next_attempt=0'); }
  clear(): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE clickhouse_state SET discarded=discarded+?,error=NULL').run(this.count());
      this.db.exec('DELETE FROM clickhouse_queue; DELETE FROM clickhouse_batch');
    })();
  }
  status(): Omit<ClickHouseStatus, 'hasCredentials' | 'running' | 'paused'> {
    this.archive.prune(); this.bound();
    const r = this.db.prepare('SELECT * FROM clickhouse_state').get() as { acknowledged: number; discarded: number; oversized: number; last_ack: string | null; error: string | null };
    const b = this.db.prepare('SELECT length(cast(payload AS BLOB)) AS bytes,attempts,next_attempt FROM clickhouse_batch').get() as { bytes: number; attempts: number; next_attempt: number } | undefined;
    const oldest = this.db.prepare('SELECT min(queued_at) AS at FROM clickhouse_queue').get() as { at: string | null };
    return { config: this.config(), queued: this.count(), batchBytes: b?.bytes ?? 0, oldestQueuedAt: oldest.at, acknowledged: r.acknowledged, discarded: r.discarded, oversized: r.oversized, lastAcknowledgedAt: r.last_ack, error: r.error, attempts: b?.attempts ?? 0, nextAttemptAt: b?.next_attempt ?? 0 };
  }
}
