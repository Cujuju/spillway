import type { Db } from './activityDb';
import { ARCHIVE_PAGE_SIZE, CAPTURE_BODY_LIMIT, normalizeArchivePolicy, type ArchiveDetail, type ArchiveEntry, type ArchivePage, type ArchivePolicy, type ArchiveQuery, type ArchiveStatus, type CapturePage } from '@shared/archive';
import { sessionKind, type ActivityEvent } from '@shared/types';
import { archiveSearchText } from '@shared/archiveContent';
import { normalizeTransport } from '@shared/activityTransport';

export const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_entries (
 id TEXT PRIMARY KEY, trace_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
 session_id TEXT, model TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', client TEXT,
 capture_id TEXT, capture_epoch TEXT, capture_sequence INTEGER, method TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', status INTEGER NOT NULL DEFAULT 0,
 bytes INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS archive_time ON archive_entries(at, id);
CREATE INDEX IF NOT EXISTS archive_session ON archive_entries(session_id, at, id);
CREATE INDEX IF NOT EXISTS archive_expiry ON archive_entries(at, id) WHERE bytes > 0;
CREATE TABLE IF NOT EXISTS archive_attempts (identity TEXT PRIMARY KEY, trace_id TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS archive_attempt_trace ON archive_attempts(trace_id);
CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(id UNINDEXED, text);
CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
export interface ArchiveFactSink { append(fact: ArchiveFact): void }
export type ArchiveFact = { kind: 'attempt' | 'capture' | 'finalized' | 'snapshot'; traceId: string; at: string; captureState: string; record: object; content: object | null };
type Row = { id: string; trace_id: string; at: string; state: ArchiveEntry['state']; reason: string; session_id: string | null; model: string; provider: string; client: string | null; capture_id: string | null; capture_epoch: string | null; capture_sequence: number | null; method: string; path: string; status: number; bytes: number; detail: string };
const ENTRY_COLUMNS = 'id,trace_id,at,state,reason,session_id,model,provider,client,capture_id,capture_epoch,capture_sequence,method,path,status,bytes';
const entry = (r: Row): ArchiveEntry => ({ schemaVersion: 1, captureEpoch: r.capture_epoch, captureSequence: r.capture_sequence, id: r.id, traceId: r.trace_id, at: r.at, state: r.state, reason: r.reason, sessionId: r.session_id, model: r.model, provider: r.provider, client: r.client, captureId: r.capture_id, method: r.method, path: r.path, status: r.status, bytes: r.bytes });
const validDate = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s));
const TRACE = /^[a-zA-Z0-9_-]{8,128}$/;
const MAX_METADATA = 20_000;
/** Longest search text; longer input is cut. */
const SEARCH_MAX_CHARS = 256;
/** Entries (`archive_entries`) whose recorded text has every whitespace-separated keyword, literally; null for blank text. */
export function archiveTextMatch(text: unknown): { sql: string; args: [string] } | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const terms = text.slice(0, SEARCH_MAX_CHARS).trim().split(/\s+/).map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND ');
  return { sql: 'id IN (SELECT id FROM archive_fts WHERE archive_fts MATCH ?)', args: [terms] };
}
const EMPTY_DETAIL = { request: '', response: '', requestType: '', responseType: '', requestEncoding: '', responseEncoding: '', format: 'http', requestDecoded: false, responseDecoded: false, frames: [] };

/** Sole owner is the Activity worker. Body data and FTS live inside the keyed database. */
export class ArchiveStore {
  private policy: ArchivePolicy;
  private lastPruned = 0;
  constructor(private db: Db, private sink?: ArchiveFactSink) {
    this.policy = normalizeArchivePolicy(this.read('policy', {}));
    this.settle('archive-reopened-before-finalization');
    this.prune(Date.now(), true);
    if (this.read('indexFormat', 0) < 2) this.db.transaction(() => {
      this.db.exec('DELETE FROM archive_fts');
      let after = '';
      for (;;) {
        const rows = this.db.prepare('SELECT id,detail FROM archive_entries WHERE id>? AND bytes>0 ORDER BY id LIMIT 8').all(after) as { id: string; detail: string }[];
        if (!rows.length) break;
        for (const r of rows) { const d = JSON.parse(r.detail) as ArchiveDetail; this.db.prepare('INSERT INTO archive_fts VALUES(?,?)').run(r.id, archiveSearchText(d.request, d.response, d.frames)); }
        after = rows.at(-1)!.id;
      }
      this.write('indexFormat', 2);
    })();
  }
  private settle(reason: string, before?: string): void {
    this.db.transaction(() => {
      const state = before ? "'missing'" : "CASE WHEN bytes>0 THEN 'partial' ELSE 'missing' END";
      const rows = this.db.prepare(`UPDATE archive_entries SET state=${state},reason=? WHERE state='pending' ${before ? "AND reason <> 'websocket-open' AND at < ?" : ''} RETURNING trace_id,at,state`).all(reason, ...before ? [before] : []) as { trace_id: string; at: string; state: string }[];
      for (const r of rows) this.sink?.append({ kind: 'finalized', traceId: r.trace_id, at: r.at, captureState: r.state, record: { state: r.state, reason }, content: null });
    })();
  }
  private read<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM archive_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  }
  private write(key: string, value: unknown): void { this.db.prepare('INSERT INTO archive_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  setPolicy(raw: ArchivePolicy): ArchiveStatus {
    return this.db.transaction(() => {
      this.policy = normalizeArchivePolicy(raw);
      this.write('policy', this.policy);
      if (!this.policy.captureBodies) this.settle('capture-disabled');
      this.prune(Date.now(), true);
      return this.status();
    })();
  }
  observe(e: ActivityEvent): void {
    if (e.source !== 'proxy' || !e.traceId || !TRACE.test(e.traceId)) return;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO archive_entries(id,trace_id,at,state,reason,session_id,model,provider,client) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(trace_id) DO UPDATE SET session_id=coalesce(excluded.session_id,session_id),model=excluded.model,provider=excluded.provider,client=coalesce(excluded.client,client)`)
        .run(`trace:${e.traceId}`, e.traceId, e.at, this.policy.captureBodies ? 'pending' : 'missing', this.policy.captureBodies ? 'awaiting-finalization' : 'metadata-only', e.sessionId, e.model, e.provider, e.client);
      const identity = JSON.stringify([e.requestId, e.at, e.authIndex]);
      const text = (v: unknown) => typeof v === 'string' && v ? v.slice(0, 512) : null;
      const measured = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
      const provenance = { source: 'proxy', model: text(e.model), effectiveModel: text(e.effectiveModel), reasoningEffort: text(e.reasoningEffort),
        provider: text(e.provider), client: text(e.client), sessionId: text(e.sessionId), parentSessionId: text(e.parentSessionId), sessionKind: sessionKind(e.sessionKind),
        failed: typeof e.failed === 'boolean' ? e.failed : null, statusCode: measured(e.statusCode), latencyMs: measured(e.latencyMs), ttftMs: measured(e.ttftMs), ...normalizeTransport(e) };
      const attempt = { requestId: e.requestId, selectionId: e.selectionId, at: e.at, provenance };
      const inserted = this.db.prepare('INSERT OR IGNORE INTO archive_attempts SELECT ?,?,? WHERE (SELECT count(*) FROM archive_attempts WHERE trace_id=?) < 200').run(identity, e.traceId, JSON.stringify(attempt), e.traceId);
      if (inserted.changes) this.sink?.append({ kind: 'attempt', traceId: e.traceId!, at: e.at, captureState: '', record: { ...attempt, sessionId: e.sessionId, model: e.model, provider: e.provider, client: e.client }, content: null });
    })();
  }
  ingest(page: CapturePage): void {
    if (!this.policy.captureBodies) return;
    if (page?.version !== 1 || typeof page.epoch !== 'string' || page.epoch.length > 128 || !Array.isArray(page.records) || page.records.length > 4) throw new Error('Invalid capture page');
    this.db.transaction(() => {
      const previous = this.read<string | null>('epoch', null);
      let sequence = previous === page.epoch ? this.read('sequence', 0) : 0;
      if (previous && previous !== page.epoch) {
        this.write('dropBaseline', 0);
        this.write('restarts', this.read('restarts', 0) + 1);
        this.settle('proxy-restarted-before-capture');
      }
      for (const r of page.records) {
        if (!r || !Number.isSafeInteger(r.sequence) || r.sequence < 1) throw new Error('Invalid capture cursor');
        if (r.sequence <= sequence) continue;
        if (r.sequence !== sequence + 1) this.write('gaps', this.read('gaps', 0) + r.sequence - sequence - 1);
        sequence = r.sequence;
        const valid = typeof r.traceId === 'string' && TRACE.test(r.traceId) && typeof r.id === 'string' && r.id.length <= 128 && validDate(r.startedAt) && r.epoch === page.epoch && ['complete', 'partial', 'missing', 'pending'].includes(r.state)
          && (['request', 'response'] as const).every((key) => typeof r[key] === 'string' && Buffer.byteLength(r[key]) <= CAPTURE_BODY_LIMIT * 4)
          && (['method', 'path', 'reason', 'requestType', 'responseType', 'requestEncoding', 'responseEncoding'] as const).every((key) => typeof r[key] === 'string' && Buffer.byteLength(r[key]) <= 8192)
          && (r.frames === undefined || Array.isArray(r.frames) && r.frames.length <= 128 && r.frames.every((f) => f && Number.isSafeInteger(f.index) && ['request', 'response'].includes(f.direction) && ['text', 'binary'].includes(f.type) && validDate(f.at) && typeof f.truncated === 'boolean' && typeof f.payload === 'string' && Buffer.byteLength(f.payload) <= 64 * 1024 * 3) && r.frames.reduce((n, f) => n + Buffer.byteLength(f.payload), 0) <= CAPTURE_BODY_LIMIT * 6);
        if (!valid) { this.write('rejected', this.read('rejected', 0) + 1); continue; }
        const captured = { request: r.request, response: r.response, requestType: r.requestType, responseType: r.responseType, requestEncoding: r.requestEncoding, responseEncoding: r.responseEncoding, format: r.format === 'websocket' ? 'websocket' : 'http', requestDecoded: r.requestDecoded === true, responseDecoded: r.responseDecoded === true, frames: r.frames ?? [] };
        const detail = JSON.stringify(captured);
        const { request, response, frames, ...metadata } = captured;
        this.sink?.append({ kind: 'capture', traceId: r.traceId, at: r.startedAt, captureState: r.state, record: { ...metadata, captureId: r.id, epoch: r.epoch, sequence: r.sequence, method: r.method, path: r.path, status: r.status, state: r.state, reason: r.reason, startedAt: r.startedAt, frameCount: frames.length }, content: request || response || frames.length ? { request, response, frames } : null });
        const id = `trace:${r.traceId}`;
        this.db.prepare(`INSERT INTO archive_entries(id,trace_id,at,state,reason,capture_id,capture_epoch,capture_sequence,method,path,status,bytes,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(trace_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,capture_id=excluded.capture_id,capture_epoch=excluded.capture_epoch,capture_sequence=excluded.capture_sequence,method=excluded.method,path=excluded.path,status=excluded.status,bytes=excluded.bytes,detail=excluded.detail`)
          .run(id, r.traceId, r.startedAt, r.state, r.reason, r.id, r.epoch, r.sequence, r.method.slice(0, 16), r.path.slice(0, 2048), Number.isSafeInteger(r.status) ? r.status : 0, r.request || r.response || r.frames?.length ? Buffer.byteLength(detail) : 0, detail);
        this.db.prepare('DELETE FROM archive_fts WHERE id=?').run(id);
        this.db.prepare('INSERT INTO archive_fts VALUES(?,?)').run(id, archiveSearchText(r.request, r.response, r.frames));
      }
      this.write('epoch', page.epoch); this.write('sequence', sequence);
      const drops = Number.isSafeInteger(page.dropped) && page.dropped >= 0 ? page.dropped : 0;
      this.write('proxyDropped', drops); this.write('dropped', Math.max(0, drops - this.read('dropBaseline', 0)));
      this.prune(Date.now(), true);
    })();
  }
  prune(now = Date.now(), force = false): void {
    if (!force && now - this.lastPruned < 60_000) return;
    const cutoff = new Date(now - this.policy.retentionDays * 86_400_000).toISOString();
    this.db.transaction(() => {
      const expire = (id: string) => {
        this.db.prepare("UPDATE archive_entries SET state='expired', reason='retention-or-byte-budget', bytes=0, detail='{}' WHERE id=?").run(id);
        this.db.prepare('DELETE FROM archive_fts WHERE id=?').run(id);
      };
      for (const r of this.db.prepare('SELECT id FROM archive_entries WHERE at < ? AND bytes > 0').all(cutoff) as { id: string }[]) expire(r.id);
      let bytes = (this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM archive_entries').get() as { n: number }).n;
      while (bytes > this.policy.maxBytes) {
        const oldest = this.db.prepare('SELECT id,bytes FROM archive_entries WHERE bytes>0 ORDER BY at,id LIMIT 128').all() as { id: string; bytes: number }[];
        if (!oldest.length) break;
        for (const r of oldest) { if (bytes <= this.policy.maxBytes) break; expire(r.id); bytes -= r.bytes; }
      }
      this.settle('capture-unavailable-or-interrupted', new Date(now - 10 * 60_000).toISOString());
      const count = (this.db.prepare('SELECT count(*) AS n FROM archive_entries').get() as { n: number }).n;
      const obsolete = count > MAX_METADATA ? this.db.prepare('SELECT id, trace_id FROM archive_entries ORDER BY at,id LIMIT ?').all(count - MAX_METADATA) as { id: string; trace_id: string }[] : [];
      for (const r of obsolete) {
        this.db.prepare('DELETE FROM archive_attempts WHERE trace_id=?').run(r.trace_id);
        this.db.prepare('DELETE FROM archive_fts WHERE id=?').run(r.id);
        this.db.prepare('DELETE FROM archive_entries WHERE id=?').run(r.id);
      }
    })();
    this.lastPruned = now;
  }
  query(q: ArchiveQuery = {}, prune = true): ArchivePage {
    if (prune) this.prune();
    const clauses: string[] = [], args: string[] = [];
    for (const [key, col] of [['sessionId', 'session_id'], ['model', 'model'], ['provider', 'provider'], ['client', 'client'], ['state', 'state']] as const) {
      if (typeof q[key] === 'string' && q[key]) { clauses.push(`${col}=?`); args.push(q[key]!.slice(0, 256)); }
    }
    for (const [key, op] of [['from', '>='], ['to', '<=']] as const) {
      if (validDate(q[key])) { clauses.push(`at ${op} ?`); args.push(new Date(q[key]!).toISOString()); }
    }
    if (typeof q.before === 'string' && q.before) {
      const cursor: unknown = JSON.parse(q.before.slice(0, 512));
      if (!Array.isArray(cursor) || cursor.length !== 2 || !validDate(cursor[0]) || typeof cursor[1] !== 'string' || cursor[1].length > 140) throw new Error('Invalid archive cursor');
      clauses.push('(at,id)<(?,?)'); args.push(cursor[0], cursor[1]);
    }
    const match = archiveTextMatch(q.text);
    if (match) { clauses.push(match.sql); args.push(...match.args); }
    const rows = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM archive_entries ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY at DESC,id DESC LIMIT ?`).all(...args, ARCHIVE_PAGE_SIZE + 1) as Row[];
    return { entries: rows.slice(0, ARCHIVE_PAGE_SIZE).map(entry), more: rows.length > ARCHIVE_PAGE_SIZE };
  }
  detail(traceId: string): ArchiveDetail | null {
    this.prune();
    if (typeof traceId !== 'string' || !TRACE.test(traceId)) return null;
    const r = this.db.prepare('SELECT * FROM archive_entries WHERE trace_id=?').get(traceId) as Row | undefined;
    if (!r) return null;
    const attempts = (this.db.prepare("SELECT detail FROM archive_attempts WHERE trace_id=? ORDER BY json_extract(detail, '$.at'),identity LIMIT 200").all(traceId) as { detail: string }[]).map((a) => JSON.parse(a.detail) as ArchiveDetail['attempts'][number]);
    return { ...entry(r), ...EMPTY_DETAIL, ...JSON.parse(r.detail), attempts };
  }
  status(): ArchiveStatus {
    const totals = this.db.prepare('SELECT count(*) AS entries, coalesce(sum(bytes),0) AS bytes FROM archive_entries').get() as { entries: number; bytes: number };
    return { policy: this.policy, ...totals, epoch: this.read('epoch', null), sequence: this.read('sequence', 0), dropped: this.read('dropped', 0), gaps: this.read('gaps', 0), restarts: this.read('restarts', 0), rejected: this.read('rejected', 0) };
  }
  clear(): void {
    this.db.transaction(() => {
      this.db.exec(ARCHIVE_CLEAR_SQL);
    })();
    this.lastPruned = 0;
  }
}
export const ARCHIVE_CLEAR_SQL = `UPDATE clickhouse_export SET discarded=discarded+queued_rows,backfill_cursor=NULL; DELETE FROM clickhouse_outbox;
DELETE FROM archive_fts; DELETE FROM archive_entries; DELETE FROM archive_attempts;
INSERT OR REPLACE INTO archive_meta VALUES ('dropBaseline', coalesce((SELECT value FROM archive_meta WHERE key='proxyDropped'),'0'));
DELETE FROM archive_meta WHERE key IN ('dropped','gaps','restarts','rejected');`;
