import type { Db } from './activityDb';
import { ARCHIVE_PAGE_SIZE, CAPTURE_BODY_LIMIT, normalizeArchivePolicy, type ArchiveDetail, type ArchiveEntry, type ArchivePage, type ArchivePolicy, type ArchiveQuery, type ArchiveStatus, type CapturePage } from '@shared/archive';
import type { ActivityEvent } from '@shared/types';

export const ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_entries (
 id TEXT PRIMARY KEY, trace_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
 session_id TEXT, model TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', client TEXT,
 capture_id TEXT, capture_epoch TEXT, capture_sequence INTEGER, method TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', status INTEGER NOT NULL DEFAULT 0,
 bytes INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS archive_time ON archive_entries(at, id);
CREATE INDEX IF NOT EXISTS archive_session ON archive_entries(session_id, at, id);
CREATE TABLE IF NOT EXISTS archive_attempts (identity TEXT PRIMARY KEY, trace_id TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS archive_attempt_trace ON archive_attempts(trace_id);
CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(id UNINDEXED, text);
CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
type Row = { id: string; trace_id: string; at: string; state: ArchiveEntry['state']; reason: string; session_id: string | null; model: string; provider: string; client: string | null; capture_id: string | null; capture_epoch: string | null; capture_sequence: number | null; method: string; path: string; status: number; bytes: number; detail: string };
const ENTRY_COLUMNS = 'id,trace_id,at,state,reason,session_id,model,provider,client,capture_id,capture_epoch,capture_sequence,method,path,status,bytes';
const entry = (r: Row): ArchiveEntry => ({ schemaVersion: 1, captureEpoch: r.capture_epoch, captureSequence: r.capture_sequence, id: r.id, traceId: r.trace_id, at: r.at, state: r.state, reason: r.reason, sessionId: r.session_id, model: r.model, provider: r.provider, client: r.client, captureId: r.capture_id, method: r.method, path: r.path, status: r.status, bytes: r.bytes });
const validDate = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s));
const TRACE = /^[a-zA-Z0-9_-]{8,128}$/;
const MAX_METADATA = 20_000;
const EMPTY_DETAIL = { request: '', response: '', requestType: '', responseType: '', requestEncoding: '', responseEncoding: '' };

/** Sole owner is the Activity worker. Body data and FTS live inside the keyed database. */
export class ArchiveStore {
  private policy: ArchivePolicy;
  constructor(private db: Db) {
    this.policy = normalizeArchivePolicy(this.read('policy', {}));
    this.prune();
  }
  private read<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM archive_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  }
  private write(key: string, value: unknown): void { this.db.prepare('INSERT OR REPLACE INTO archive_meta VALUES (?, ?)').run(key, JSON.stringify(value)); }
  setPolicy(raw: ArchivePolicy): ArchiveStatus {
    this.policy = normalizeArchivePolicy(raw);
    this.write('policy', this.policy);
    if (!this.policy.captureBodies) this.db.prepare("UPDATE archive_entries SET state='missing', reason='capture-disabled' WHERE state='pending'").run();
    this.prune();
    return this.status();
  }
  observe(e: ActivityEvent): void {
    if (e.source !== 'proxy' || !e.traceId || !TRACE.test(e.traceId)) return;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO archive_entries(id,trace_id,at,state,reason,session_id,model,provider,client) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(trace_id) DO UPDATE SET session_id=coalesce(excluded.session_id,session_id),model=excluded.model,provider=excluded.provider,client=coalesce(excluded.client,client)`)
        .run(`trace:${e.traceId}`, e.traceId, e.at, this.policy.captureBodies ? 'pending' : 'missing', this.policy.captureBodies ? 'awaiting-finalization' : 'metadata-only', e.sessionId, e.model, e.provider, e.client);
      const identity = JSON.stringify([e.requestId, e.at, e.authIndex]);
      this.db.prepare('INSERT OR IGNORE INTO archive_attempts SELECT ?,?,? WHERE (SELECT count(*) FROM archive_attempts WHERE trace_id=?) < 200').run(identity, e.traceId, JSON.stringify({ requestId: e.requestId, selectionId: e.selectionId, at: e.at }), e.traceId);
    })();
  }
  ingest(page: CapturePage): void {
    if (!this.policy.captureBodies) return;
    if (page?.version !== 1 || typeof page.epoch !== 'string' || page.epoch.length > 128 || !Array.isArray(page.records) || page.records.length > 4) throw new Error('Invalid capture page');
    this.db.transaction(() => {
      const previous = this.read<string | null>('epoch', null);
      let sequence = previous === page.epoch ? this.read('sequence', 0) : 0;
      if (previous && previous !== page.epoch) {
        this.write('restarts', this.read('restarts', 0) + 1);
        this.db.prepare("UPDATE archive_entries SET state='missing', reason='proxy-restarted-before-capture' WHERE state='pending'").run();
      }
      for (const r of page.records) {
        if (!r || !TRACE.test(r.traceId) || typeof r.id !== 'string' || r.id.length > 128 || !validDate(r.startedAt) || r.epoch !== page.epoch || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !['complete', 'partial', 'missing'].includes(r.state)) throw new Error('Invalid capture record');
        if (r.sequence <= sequence) continue;
        if (r.sequence !== sequence + 1) this.write('gaps', this.read('gaps', 0) + r.sequence - sequence - 1);
        for (const key of ['request', 'response', 'method', 'path', 'reason', 'requestType', 'responseType', 'requestEncoding', 'responseEncoding'] as const) {
          if (typeof r[key] !== 'string' || Buffer.byteLength(r[key]) > CAPTURE_BODY_LIMIT * 3) throw new Error('Capture exceeds byte limit');
        }
        const detail = JSON.stringify({ request: r.request, response: r.response, requestType: r.requestType, responseType: r.responseType, requestEncoding: r.requestEncoding, responseEncoding: r.responseEncoding });
        const id = `trace:${r.traceId}`;
        this.db.prepare(`INSERT INTO archive_entries(id,trace_id,at,state,reason,capture_id,capture_epoch,capture_sequence,method,path,status,bytes,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(trace_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,capture_id=excluded.capture_id,capture_epoch=excluded.capture_epoch,capture_sequence=excluded.capture_sequence,method=excluded.method,path=excluded.path,status=excluded.status,bytes=excluded.bytes,detail=excluded.detail`)
          .run(id, r.traceId, r.startedAt, r.state, r.reason, r.id, r.epoch, r.sequence, r.method.slice(0, 16), r.path.slice(0, 2048), Number.isSafeInteger(r.status) ? r.status : 0, Buffer.byteLength(detail), detail);
        this.db.prepare('DELETE FROM archive_fts WHERE id=?').run(id);
        this.db.prepare('INSERT INTO archive_fts VALUES(?,?)').run(id, `${r.request}\n${r.response}`);
        sequence = r.sequence;
      }
      this.write('epoch', page.epoch); this.write('sequence', sequence);
      this.write('dropped', Number.isSafeInteger(page.dropped) && page.dropped >= 0 ? page.dropped : 0);
      this.prune();
    })();
  }
  prune(now = Date.now()): void {
    const cutoff = new Date(now - this.policy.retentionDays * 86_400_000).toISOString();
    this.db.transaction(() => {
      const expire = (id: string) => {
        this.db.prepare("UPDATE archive_entries SET state='expired', reason='retention-or-byte-budget', bytes=0, detail='{}' WHERE id=?").run(id);
        this.db.prepare('DELETE FROM archive_fts WHERE id=?').run(id);
      };
      for (const r of this.db.prepare('SELECT id FROM archive_entries WHERE at < ? AND bytes > 0').all(cutoff) as { id: string }[]) expire(r.id);
      let bytes = (this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM archive_entries').get() as { n: number }).n;
      for (const r of this.db.prepare('SELECT id, bytes FROM archive_entries WHERE bytes > 0 ORDER BY at, id').all() as { id: string; bytes: number }[]) {
        if (bytes <= this.policy.maxBytes) break;
        expire(r.id); bytes -= r.bytes;
      }
      this.db.prepare("UPDATE archive_entries SET state='missing', reason='capture-unavailable-or-interrupted' WHERE state='pending' AND at < ?").run(new Date(now - 10 * 60_000).toISOString());
      const obsolete = this.db.prepare('SELECT id FROM archive_entries ORDER BY at DESC,id DESC LIMIT -1 OFFSET ?').all(MAX_METADATA) as { id: string }[];
      for (const r of obsolete) {
        this.db.prepare('DELETE FROM archive_fts WHERE id=?').run(r.id);
        this.db.prepare('DELETE FROM archive_entries WHERE id=?').run(r.id);
      }
      this.db.exec('DELETE FROM archive_attempts WHERE trace_id NOT IN (SELECT trace_id FROM archive_entries)');
    })();
  }
  query(q: ArchiveQuery = {}): ArchivePage {
    this.prune();
    const clauses: string[] = [], args: string[] = [];
    for (const [key, col] of [['sessionId', 'session_id'], ['model', 'model'], ['provider', 'provider'], ['client', 'client'], ['state', 'state']] as const) {
      if (typeof q[key] === 'string' && q[key]) { clauses.push(`${col}=?`); args.push(q[key]!.slice(0, 256)); }
    }
    for (const [key, op] of [['from', '>='], ['to', '<=']] as const) {
      if (validDate(q[key])) { clauses.push(`at ${op} ?`); args.push(new Date(q[key]!).toISOString()); }
    }
    if (typeof q.before === 'string' && q.before) {
      clauses.push('(at,id)<(SELECT at,id FROM archive_entries WHERE id=?)'); args.push(q.before.slice(0, 140));
    }
    if (typeof q.text === 'string' && q.text.trim()) {
      const terms = q.text.slice(0, 256).trim().split(/\s+/).map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND ');
      clauses.push('id IN (SELECT id FROM archive_fts WHERE archive_fts MATCH ?)'); args.push(terms);
    }
    const rows = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM archive_entries ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY at DESC,id DESC LIMIT ?`).all(...args, ARCHIVE_PAGE_SIZE + 1) as Row[];
    return { entries: rows.slice(0, ARCHIVE_PAGE_SIZE).map(entry), more: rows.length > ARCHIVE_PAGE_SIZE };
  }
  detail(traceId: string): ArchiveDetail | null {
    this.prune();
    if (typeof traceId !== 'string' || !TRACE.test(traceId)) return null;
    const r = this.db.prepare('SELECT * FROM archive_entries WHERE trace_id=?').get(traceId) as Row | undefined;
    if (!r) return null;
    const attempts = (this.db.prepare('SELECT detail FROM archive_attempts WHERE trace_id=? ORDER BY identity LIMIT 200').all(traceId) as { detail: string }[]).map((a) => JSON.parse(a.detail) as ArchiveDetail['attempts'][number]);
    return { ...entry(r), ...EMPTY_DETAIL, ...JSON.parse(r.detail), attempts };
  }
  status(): ArchiveStatus {
    const totals = this.db.prepare('SELECT count(*) AS entries, coalesce(sum(bytes),0) AS bytes FROM archive_entries').get() as { entries: number; bytes: number };
    return { policy: this.policy, ...totals, epoch: this.read('epoch', null), sequence: this.read('sequence', 0), dropped: this.read('dropped', 0), gaps: this.read('gaps', 0), restarts: this.read('restarts', 0) };
  }
  clear(): void { this.db.exec('DELETE FROM archive_fts; DELETE FROM archive_entries; DELETE FROM archive_attempts;'); }
}
