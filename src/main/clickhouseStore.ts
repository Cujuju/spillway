import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { CLICKHOUSE_BATCH_BYTES, CLICKHOUSE_BATCH_ROWS, CLICKHOUSE_OUTBOX_BYTES, DEFAULT_CLICKHOUSE_CONFIG, validateClickHouseConfig, type ClickHouseBatch, type ClickHouseConfig, type ClickHouseStatus, type ClickHouseStoreName } from '@shared/clickhouse';
import type { Db } from './activityDb';
import type { ArchiveFact, ArchiveFactSink, ArchiveStore } from './archiveStore';
import { pieceBytes, rebuild, type PieceDetail } from './archivePieces';
import { wireThread } from './archiveStreams';
import { CDC_SCHEMA, emitCdcCaptureChunks } from './clickhouseCdc';
import { CLICKHOUSE_DISK_FULL_ERROR } from './clickhouseHttp';
import { CLICKHOUSE_BASE64_WIRE, CLICKHOUSE_CDC_WIRE_VERSION, CLICKHOUSE_RAW_WIRE_VERSION, encodeCdcPiece, encodeRawPiece, isCdcWireContent, isWireContent, wireContent, type ClickHouseWireVersion, type QueuedPieceContent } from './clickhouseWire';
import { encodeClickHouseLine, encodeRecordLine, outboxBytes, type OutboxRow } from './clickhouseLine';
import { backfillRecords, mirrorRecords, recordSpec, resolveRecord, restartRecordCursors, syncRecordTriggers, type MirrorPrune, type MirrorRecord } from './clickhouseRecords';

const RETRY_INITIAL_MS = 1_000, RETRY_MAX_MS = 300_000, RETRY_MAX_EXPONENT = 9;
const RETRY_JITTER_FRACTION = 0.5;
const RAW_DELIVERY_DESTINATION = 'clickhouseRawDeliveryDestination';
const CDC_DELIVERY_DESTINATION = 'clickhouseCdcDeliveryDestination';
const localPieceIds = (list = '') => list.split(',').map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
export const CLICKHOUSE_SCHEMA = `
DROP TABLE IF EXISTS clickhouse_batch; DROP TABLE IF EXISTS clickhouse_queue; DROP TABLE IF EXISTS clickhouse_state;
CREATE TABLE IF NOT EXISTS clickhouse_export (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), source_id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
 config TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_CLICKHOUSE_CONFIG)}', acknowledged INTEGER NOT NULL DEFAULT 0,
 content_expired INTEGER NOT NULL DEFAULT 0, discarded INTEGER NOT NULL DEFAULT 0, oversized INTEGER NOT NULL DEFAULT 0, last_ack TEXT, error TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, backfill_cursor TEXT,
 queued_rows INTEGER NOT NULL DEFAULT 0, queued_bytes INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO clickhouse_export(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS clickhouse_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, trace_id TEXT NOT NULL, at TEXT NOT NULL,
 thread_id TEXT NOT NULL DEFAULT '', expired INTEGER NOT NULL DEFAULT 0, capture_state TEXT NOT NULL, record TEXT NOT NULL, content TEXT, bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clickhouse_outbox_thread ON clickhouse_outbox(thread_id);
CREATE INDEX IF NOT EXISTS clickhouse_outbox_trace ON clickhouse_outbox(trace_id) WHERE content IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS clickhouse_outbox_insert AFTER INSERT ON clickhouse_outbox BEGIN
 UPDATE clickhouse_export SET queued_rows=queued_rows+1,queued_bytes=queued_bytes+NEW.bytes;
END;
CREATE TRIGGER IF NOT EXISTS clickhouse_outbox_delete AFTER DELETE ON clickhouse_outbox BEGIN
 UPDATE clickhouse_export SET queued_rows=queued_rows-1,queued_bytes=queued_bytes-OLD.bytes;
END;
` + CDC_SCHEMA;
export const clickhouseDestination = (c: ClickHouseConfig): string => createHash('sha256').update(JSON.stringify([c.endpoint, c.database, c.tablePrefix])).digest('hex');
type State = { source_id: string; config: string; record_cursors: string; acknowledged: number; discarded: number; oversized: number; content_expired: number; last_ack: string | null; error: string | null; attempts: number; next_attempt: number; backfill_cursor: string | null };

export class ClickHouseStore implements ArchiveFactSink {
  constructor(private db: Db, private archive: ArchiveStore) {}
  private state(): State { return this.db.prepare('SELECT * FROM clickhouse_export').get() as State; }
  config(): ClickHouseConfig { return validateClickHouseConfig(JSON.parse(this.state().config)); }
  rawWireEnabled(): boolean { return this.config().rawWire; }
  cdcWireEnabled(): boolean { return this.config().cdcWire; }
  cdcExportMode(): 'off' | 'metadata' | 'bodies' {
    const c = this.config();
    if (!c.enabled || !c.stores.traces) return 'off';
    if (!c.includeBodies) return 'metadata';
    this.bindCdcDelivery(clickhouseDestination(c));
    return 'bodies';
  }
  private bindRawDelivery(destination: string): void {
    const binding = this.db.prepare('SELECT value FROM archive_meta WHERE key=?').get(RAW_DELIVERY_DESTINATION) as { value: string } | undefined;
    if (binding?.value === destination) return;
    // Older builds reset only the base64 delivery flags when changing destinations.
    this.db.exec('UPDATE archive_pieces SET sent_raw=0 WHERE sent_raw<>0');
    this.db.prepare('INSERT OR REPLACE INTO archive_meta(key,value) VALUES(?,?)').run(RAW_DELIVERY_DESTINATION, destination);
  }
  private bindCdcDelivery(destination: string): void {
    const binding = this.db.prepare('SELECT value FROM archive_meta WHERE key=?').get(CDC_DELIVERY_DESTINATION) as { value: string } | undefined;
    if (binding?.value === destination) return;
    // Only clear when a different destination was previously bound (e.g. changed by an older build);
    // first-time initialization must preserve chunks already queued before the first prepare().
    if (binding !== undefined) this.db.exec('DELETE FROM clickhouse_cdc_chunks');
    this.db.prepare('INSERT OR REPLACE INTO archive_meta(key,value) VALUES(?,?)').run(CDC_DELIVERY_DESTINATION, destination);
  }
  private totals(): { n: number; bytes: number } { return this.db.prepare('SELECT queued_rows AS n,queued_bytes AS bytes FROM clickhouse_export').get() as { n: number; bytes: number }; }
  configure(raw: ClickHouseConfig): void {
    const next = validateClickHouseConfig(raw), prev = this.config();
    this.db.transaction(() => {
      const destination = clickhouseDestination(next);
      const changed = destination !== clickhouseDestination(prev);
      if (changed) {
        // Queued rows belong to the old destination; backfill below re-sends everything still stored locally.
        this.db.prepare('UPDATE clickhouse_export SET discarded=discarded+?,attempts=0,next_attempt=0').run(this.totals().n);
        this.db.exec('DELETE FROM clickhouse_outbox; UPDATE archive_pieces SET sent=0, sent_raw=0; DELETE FROM clickhouse_cdc_chunks');
        this.bindRawDelivery(destination);
        this.bindCdcDelivery(destination);
      }
      this.db.prepare('UPDATE clickhouse_export SET config=?,error=NULL').run(JSON.stringify(next));
      if (prev.deliveryPaused && !next.deliveryPaused) this.db.exec('UPDATE clickhouse_export SET attempts=0,next_attempt=0');
      const everything = !prev.enabled || changed;
      if (next.enabled && next.stores.traces && (everything || !prev.stores.traces || !prev.includeBodies && next.includeBodies)) this.db.prepare('UPDATE clickhouse_export SET backfill_cursor=?').run(JSON.stringify(['', '']));
      if (next.enabled) restartRecordCursors(this.db, prev, next, everything);
      syncRecordTriggers(this.db, next);
    })();
  }
  append(fact: ArchiveFact): void {
    const config = this.config();
    if (!config.enabled || !config.stores.traces) return;
    this.db.transaction(() => {
      const record = JSON.stringify(fact.record), content = !config.includeBodies || fact.content === null ? null : JSON.stringify(fact.content);
      const thread = fact.content ? (fact.content as PieceDetail).thread : (this.db.prepare('SELECT thread_id FROM archive_entries WHERE trace_id=?').get(fact.traceId) as { thread_id: string | null } | undefined)?.thread_id;
      const row: OutboxRow = { thread_id: thread ?? '', seq: Number.MAX_SAFE_INTEGER, kind: fact.kind, trace_id: fact.traceId, at: fact.at, capture_state: fact.captureState, record, content: null };
      if (!Number.isFinite(Date.parse(fact.at))) { this.db.exec('UPDATE clickhouse_export SET discarded=discarded+1'); return; }
      if (Buffer.byteLength(encodeClickHouseLine(row, config, this.state().source_id, false)) > CLICKHOUSE_BATCH_BYTES) {
        this.db.exec('UPDATE clickhouse_export SET discarded=discarded+1,oversized=oversized+1'); return;
      }
      const bytes = outboxBytes({ ...row, content });
      this.db.prepare('INSERT INTO clickhouse_outbox(kind,trace_id,at,capture_state,record,content,bytes,thread_id) VALUES(?,?,?,?,?,?,?,?)').run(fact.kind, fact.traceId, fact.at, fact.captureState, record, content, bytes, thread ?? '');

    })();
  }
  private backfill(): void {
    let cursor = this.state().backfill_cursor, appended = 0, snapshots = 0;
    while (cursor !== null && snapshots < CLICKHOUSE_BATCH_ROWS && appended < CLICKHOUSE_BATCH_BYTES && this.totals().bytes < CLICKHOUSE_OUTBOX_BYTES) {
      const [at, id, savedWireAfter] = JSON.parse(cursor) as [string, string, number?];
      const row = this.db.prepare(`SELECT id,at,trace_id FROM archive_entries WHERE (at,id)${savedWireAfter === undefined ? '>' : '>='}(?,?) ORDER BY at,id LIMIT 1`).get(at, id) as { id: string; at: string; trace_id: string } | undefined;
      if (!row) { this.db.exec('UPDATE clickhouse_export SET backfill_cursor=NULL'); break; }
      const wireAfter = row.id === id ? savedWireAfter : undefined;
      const savedWire = this.db.prepare(`SELECT e.detail,e.capture_id,e.capture_epoch,e.capture_sequence,e.state,e.reason,e.method,e.path,e.status,t.clickhouse_wire_version AS exportVersion
        FROM archive_entries e LEFT JOIN archive_threads t ON t.id=e.thread_id WHERE e.id=?`).get(row.id) as {
        detail: string; capture_id: string; capture_epoch: string; capture_sequence: number; state: string; reason: string;
        method: string; path: string; status: number; exportVersion: ClickHouseWireVersion | null;
      };
      const wire = JSON.parse(savedWire.detail) as { wire?: number; [key: string]: unknown };
      if (wire.wire === 2) {
        const thread = wireThread(savedWire.capture_epoch, savedWire.capture_id);
        if (savedWire.exportVersion === CLICKHOUSE_CDC_WIRE_VERSION) {
          this.append({ kind: 'capture-start', traceId: row.trace_id, at: row.at, captureState: 'pending', record: { ...wire, captureId: savedWire.capture_id, epoch: savedWire.capture_epoch, sequence: wire.firstSequence, requestBytes: 0, responseBytes: 0, frameCount: 0, requestSha256: '', responseSha256: '', state: 'pending', reason: 'capture-open', method: savedWire.method, path: savedWire.path, status: 0 }, content: null });
          snapshots++;
          if (savedWire.state !== 'pending') {
            snapshots += emitCdcCaptureChunks(this.db, { entryId: row.id, traceId: row.trace_id, captureId: savedWire.capture_id, epoch: savedWire.capture_epoch, startedAt: row.at, thread }, this);
            this.append({ kind: 'capture-end', traceId: row.trace_id, at: row.at, captureState: savedWire.state, record: { ...wire, captureId: savedWire.capture_id, epoch: savedWire.capture_epoch, sequence: savedWire.capture_sequence, state: savedWire.state, reason: savedWire.reason, method: savedWire.method, path: savedWire.path, status: savedWire.status }, content: null });
            snapshots++;
          }
          cursor = JSON.stringify([row.at, row.id]);
          this.db.prepare('UPDATE clickhouse_export SET backfill_cursor=?').run(cursor);
          continue;
        }
        if (wireAfter === undefined) {
          this.append({ kind: 'capture-start', traceId: row.trace_id, at: row.at, captureState: 'pending', record: { ...wire, captureId: savedWire.capture_id, epoch: savedWire.capture_epoch, sequence: wire.firstSequence, requestBytes: 0, responseBytes: 0, frameCount: 0, requestSha256: '', responseSha256: '', state: 'pending', reason: 'capture-open', method: savedWire.method, path: savedWire.path, status: 0 }, content: null });
          cursor = JSON.stringify([row.at, row.id, 0]); this.db.prepare('UPDATE clickhouse_export SET backfill_cursor=?').run(cursor); snapshots++;
        }
        const chunks = this.db.prepare('SELECT sequence,piece_id,direction,offset,frame_index,frame_type,frame_at,frame_end FROM archive_wire WHERE entry_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(row.id, wireAfter ?? 0, CLICKHOUSE_BATCH_ROWS - snapshots) as { sequence: number; piece_id: number | null; direction: string; offset: number; frame_index: number; frame_type: string; frame_at: string; frame_end: number }[];
        for (const chunk of chunks) {
          const bytes = chunk.piece_id === null ? 0 : pieceBytes(this.db, chunk.piece_id).length;
          this.append({ kind: 'capture-chunk', traceId: row.trace_id, at: row.at, captureState: 'pending', record: { captureId: savedWire.capture_id, epoch: savedWire.capture_epoch, sequence: chunk.sequence, representation: CLICKHOUSE_BASE64_WIRE, rawBytes: bytes, chunk: { direction: chunk.direction, offset: chunk.offset, frame: chunk.frame_index, type: chunk.frame_type, at: chunk.frame_at, end: Boolean(chunk.frame_end) } }, content: wireContent(thread, savedWire.exportVersion, chunk.piece_id, bytes) });
          cursor = JSON.stringify([row.at, row.id, chunk.sequence]);
          this.db.prepare('UPDATE clickhouse_export SET backfill_cursor=?').run(cursor); snapshots++;
        }
        if (snapshots >= CLICKHOUSE_BATCH_ROWS) break;
        if (savedWire.state !== 'pending') this.append({ kind: 'capture-end', traceId: row.trace_id, at: row.at, captureState: savedWire.state, record: { ...wire, captureId: savedWire.capture_id, epoch: savedWire.capture_epoch, sequence: savedWire.capture_sequence, state: savedWire.state, reason: savedWire.reason, method: savedWire.method, path: savedWire.path, status: savedWire.status }, content: null });
        cursor = JSON.stringify([row.at, row.id]);
        this.db.prepare('UPDATE clickhouse_export SET backfill_cursor=?').run(cursor); snapshots++;
        continue;
      }
      const detail = this.archive.detail(row.trace_id);
      if (detail) {
        const { request: _request, response: _response, frames: _frames, ...record } = detail;
        const saved = this.db.prepare('SELECT detail FROM archive_entries WHERE id=? AND bytes>0').get(row.id) as { detail: string } | undefined;
        const content = saved ? JSON.parse(saved.detail) : null;
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
    const initialConfig = this.config();
    if (!initialConfig.enabled || initialConfig.deliveryPaused || this.state().next_attempt > Date.now()) return null;
    return this.db.transaction(() => {
      const destination = clickhouseDestination(initialConfig);
      this.bindRawDelivery(destination);
      this.bindCdcDelivery(destination);
      this.archive.prune(); this.backfill(); backfillRecords(this.db, initialConfig);
      const config = this.config(), state = this.state();
      const content = config.includeBodies ? 'content' : 'NULL AS content';
      const pending = this.db.prepare(`SELECT seq,kind,record_key,trace_id,at,capture_state,record,expired,thread_id,${content} FROM clickhouse_outbox ORDER BY seq LIMIT ?`).iterate(CLICKHOUSE_BATCH_ROWS) as IterableIterator<OutboxRow>;
      let facts = '', pieces = '', bytes = 0, rows = 0, last = 0;
      const gone: number[] = [];
      const sent = new Set<number>(), sentRaw = new Set<number>(), sentCdc = new Set<number>();
      const rawPieces: Buffer[] = [];
      const selectPiece = this.db.prepare('SELECT p.sent,p.sent_raw,p.thread_id,t.first_at FROM archive_pieces p JOIN archive_threads t ON t.id=p.thread_id WHERE p.id=?');
      const selectCdc = this.db.prepare('SELECT sent,first_at,bytes FROM clickhouse_cdc_chunks WHERE id=?');
      for (const r of pending) {
        let line: string;
        if (recordSpec(r.kind)) {
          const record = resolveRecord(this.db, r.kind, r.record_key ?? '', config.includeBodies);
          if (!record) {
            gone.push(r.seq);
            continue;
          }
          line = encodeRecordLine(r, record, config, state.source_id);
        } else {
          const refs = r.content ? JSON.parse(r.content) as QueuedPieceContent : null;
          const cdc = isCdcWireContent(refs);
          const wire = isWireContent(refs);
          const raw = wire && refs.exportVersion === CLICKHOUSE_RAW_WIRE_VERSION;
          const resolved = refs && !wire && !cdc ? rebuild(this.db, refs) : undefined;
          let partial = false;
          if (cdc) {
            for (const [id] of refs.chunks) {
              if (sentCdc.has(id)) continue;
              const chunk = selectCdc.get(id) as { sent: number; first_at: string; bytes: Buffer | null } | undefined;
              if (!chunk) throw new Error('Queued ClickHouse CDC chunk is unavailable');
              if (chunk.sent) continue;
              if (!chunk.bytes) throw new Error('Queued ClickHouse CDC chunk is unavailable');
              const data = zstdDecompressSync(chunk.bytes);
              const addition = encodeCdcPiece(state.source_id, id, chunk.first_at, data);
              const size = addition.byteLength;
              if (rows && (bytes + size > CLICKHOUSE_BATCH_BYTES || rows === CLICKHOUSE_BATCH_ROWS)) { partial = true; break; }
              rawPieces.push(addition);
              bytes += size; rows++; sentCdc.add(id);
            }
          } else {
            const included = raw ? sentRaw : sent;
            for (const [id] of refs?.request ?? []) {
              if (included.has(id)) continue;
              const piece = selectPiece.get(id) as { sent: number; sent_raw: number; thread_id: string; first_at: string } | undefined;
              if (!piece) throw new Error('Queued ClickHouse content is unavailable');
              if (raw ? piece.sent_raw : piece.sent) continue;
              const data = pieceBytes(this.db, id);
              const addition = raw ? encodeRawPiece(state.source_id, piece.thread_id, id, piece.first_at, data)
                : JSON.stringify({ source_id: state.source_id, thread_id: piece.thread_id, seq: id, at: piece.first_at.replace('T', ' ').replace('Z', ''), bytes: data.toString(wire ? 'base64' : 'utf8') }) + '\n';
              const size = Buffer.byteLength(addition);
              if (rows && (bytes + size > CLICKHOUSE_BATCH_BYTES || rows === CLICKHOUSE_BATCH_ROWS)) { partial = true; break; }
              if (typeof addition === 'string') pieces += addition;
              else rawPieces.push(addition);
              bytes += size; rows++; included.add(id);
            }
          }
          if (partial) break;
          line = encodeClickHouseLine(r, config, state.source_id, true, resolved);
        }
        const size = Buffer.byteLength(line);
        if (rows && (bytes + size > CLICKHOUSE_BATCH_BYTES || rows === CLICKHOUSE_BATCH_ROWS)) break;
        facts += line; bytes += size; rows++; last = r.seq;
        if (bytes >= CLICKHOUSE_BATCH_BYTES) break;
      }
      for (const seq of gone) this.db.prepare('DELETE FROM clickhouse_outbox WHERE seq=?').run(seq);
      if (gone.length) this.db.prepare('UPDATE clickhouse_export SET discarded=discarded+?').run(gone.length);
      if (!rows) return null;
      const token = `${destination}:${last}:${[...sent].join(',')}:${[...sentRaw].join(',')}:${[...sentCdc].join(',')}`;
      return { token, destination, pieces, rawPieces: rawPieces.length ? Buffer.concat(rawPieces) : undefined, facts, rows, attempts: state.attempts, nextAttemptAt: state.next_attempt };
    })();
  }
  acknowledge(token: string, destination: string): void {
    const [fingerprint, rawSeq, sent, sentRaw, sentCdc] = token.split(':'), seq = Number(rawSeq);
    if (fingerprint !== destination || destination !== clickhouseDestination(this.config()) || !Number.isSafeInteger(seq) || seq < 0) return;
    this.db.transaction(() => {
      for (const id of localPieceIds(sent)) this.db.prepare('UPDATE archive_pieces SET sent=1 WHERE id=?').run(id);
      for (const id of localPieceIds(sentRaw)) this.db.prepare('UPDATE archive_pieces SET sent_raw=1 WHERE id=?').run(id);
      for (const id of localPieceIds(sentCdc)) this.db.prepare('UPDATE clickhouse_cdc_chunks SET sent=1, bytes=NULL WHERE id=?').run(id);
      const deleted = this.db.prepare('DELETE FROM clickhouse_outbox WHERE seq<=?').run(seq).changes;
      if (!this.db.prepare('SELECT 1 FROM clickhouse_outbox WHERE content IS NOT NULL LIMIT 1').get()) {
        this.db.exec('DELETE FROM clickhouse_cdc_chunks WHERE sent=0');
      }
      this.db.prepare('UPDATE clickhouse_export SET acknowledged=acknowledged+?,last_ack=?,error=NULL,attempts=0,next_attempt=0').run(deleted, new Date().toISOString());
    })();
  }
  fail(token: string, now: number, error: string): void {
    const config = this.config();
    if (!token.startsWith(`${clickhouseDestination(config)}:`)) return;
    if (error === CLICKHOUSE_DISK_FULL_ERROR) {
      // Server disk is full: persist delivery pause instead of retrying until space is freed.
      this.db.prepare('UPDATE clickhouse_export SET config=?,attempts=0,next_attempt=0,error=?').run(JSON.stringify({ ...config, deliveryPaused: true }), error.slice(0, 256));
      return;
    }
    const delay = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(this.state().attempts, RETRY_MAX_EXPONENT));
    this.db.prepare('UPDATE clickhouse_export SET attempts=attempts+1,next_attempt=?,error=?').run(now + delay * (1 - RETRY_JITTER_FRACTION * Math.random()), error.slice(0, 256));
  }
  mirror(store: ClickHouseStoreName, records: MirrorRecord[], prune: MirrorPrune): void { mirrorRecords(this.db, this.config(), store, records, prune); }
  retry(): void {
    const config = this.config();
    if (config.deliveryPaused) {
      this.db.prepare('UPDATE clickhouse_export SET config=?,attempts=0,next_attempt=0,error=NULL').run(JSON.stringify({ ...config, deliveryPaused: false }));
    } else {
      this.db.exec('UPDATE clickhouse_export SET next_attempt=0');
    }
  }
  clear(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE clickhouse_export SET discarded=discarded+?,error=NULL,backfill_cursor=NULL,record_cursors='{}'").run(this.totals().n);
      this.db.exec('DELETE FROM clickhouse_outbox; DELETE FROM clickhouse_cdc_chunks WHERE sent=0');
    })();
  }
  status(): Omit<ClickHouseStatus, 'hasCredentials' | 'running' | 'paused'> {
    const r = this.state(), totals = this.totals();
    const oldest = this.db.prepare('SELECT at FROM clickhouse_outbox ORDER BY seq LIMIT 1').get() as { at: string } | undefined;
    return { config: this.config(), queued: totals.n, queuedBytes: totals.bytes, oldestQueuedAt: oldest?.at ?? null, acknowledged: r.acknowledged, discarded: r.discarded, oversized: r.oversized, contentExpired: r.content_expired, attempts: r.attempts, nextAttemptAt: r.next_attempt, lastAcknowledgedAt: r.last_ack, error: r.error, backfilling: this.config().enabled && (r.backfill_cursor !== null || r.record_cursors !== '{}') };
  }
}
