import { createHash } from 'node:crypto';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Db } from './activityDb';
import type { ArchiveDetail } from '@shared/archive';
import { archiveSearchText } from '@shared/archiveContent';
export type Range = [number, number, number];
export type Body = Pick<ArchiveDetail, 'request' | 'response' | 'frames' | 'requestType' | 'responseType' | 'requestEncoding' | 'responseEncoding' | 'format' | 'requestDecoded' | 'responseDecoded'>;
export type PieceDetail = Omit<Body, 'request' | 'response' | 'frames'> & { thread: string; request: Range[]; response: Range[]; frames: Range[] };
const MIGRATION_BATCH = 8;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const PIECE_SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_threads(id TEXT PRIMARY KEY,first_at TEXT NOT NULL,last_at TEXT NOT NULL,over_budget INTEGER NOT NULL DEFAULT 0,stored_bytes INTEGER NOT NULL DEFAULT 0,logical_bytes INTEGER NOT NULL DEFAULT 0,base TEXT);
CREATE TABLE IF NOT EXISTS archive_pieces(id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT,bytes BLOB NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS archive_piece_thread ON archive_pieces(thread_id);
CREATE TABLE IF NOT EXISTS archive_pins(piece_id INTEGER NOT NULL,case_id TEXT NOT NULL,PRIMARY KEY(piece_id,case_id));
CREATE TABLE IF NOT EXISTS archive_search_keys(id INTEGER PRIMARY KEY AUTOINCREMENT,entry_id TEXT UNIQUE NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS archive_search USING fts5(text,content='',contentless_delete=1);
`;
export function rebuild(db: Db, refs: PieceDetail, requestOnly = false): Body {
  const cache = new Map<number, Buffer>();
  const field = (ranges: Range[]) => Buffer.concat(ranges.map(([id, offset, length]) => {
    if (!cache.has(id)) {
      const p = db.prepare('SELECT bytes FROM archive_pieces WHERE id=?').get(id) as { bytes: Buffer } | undefined;
      if (!p) throw new Error('Archive piece unavailable');
      cache.set(id, zstdDecompressSync(p.bytes));
    }
    const bytes = cache.get(id)!;
    if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error('Archive range unavailable');
    return bytes.subarray(offset, offset + length);
  })).toString('utf8');
  const { thread: _thread, ...metadata } = refs;
  return { ...metadata, request: field(refs.request), response: requestOnly ? '' : field(refs.response), frames: requestOnly ? [] : JSON.parse(field(refs.frames)) };
}
export function readBody(db: Db, text: string): Body {
  const value = JSON.parse(text);
  return Array.isArray(value.request) ? rebuild(db, value) : value;
}
export function sliceRanges(ranges: Range[], start: number, length: number): Range[] {
  const out: Range[] = [];
  for (const [id, offset, size] of ranges) {
    const take = Math.min(size - start, length);
    if (take > 0) { out.push([id, offset + start, take]); length -= take; }
    start = Math.max(0, start - size);
    if (!length) break;
  }
  return out;
}
function merge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const last = out.at(-1);
    if (last && last[0] === r[0] && last[1] + last[2] === r[1]) last[2] += r[2]; else out.push([...r]);
  }
  return out;
}
export function storeBody(db: Db, id: string, body: Body, bases?: Map<string, { detail: string; request: Buffer }>): PieceDetail {
  const e = db.prepare('SELECT at,session_id,model,thread_id FROM archive_entries WHERE id=?').get(id) as { at: string; session_id: string | null; model: string; thread_id: string | null };
  const thread = e.thread_id ?? JSON.stringify(e.session_id ? [e.session_id, e.model] : [id]);
  db.prepare('INSERT INTO archive_threads(id,first_at,last_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_at=max(last_at,excluded.last_at)').run(thread, e.at, e.at);
  const put = (bytes: Buffer): Range[] => bytes.length ? [[Number(db.prepare('INSERT INTO archive_pieces(thread_id,bytes) VALUES(?,?)').run(thread, zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 3 } })).lastInsertRowid), 0, bytes.length]] : [];
  const request = Buffer.from(body.request), response = Buffer.from(body.response), frames = Buffer.from(JSON.stringify(body.frames));
  let base: PieceDetail | null = null;
  let previous: Buffer = Buffer.alloc(0);
  try {
    const row = db.prepare('SELECT base FROM archive_threads WHERE id=?').get(thread) as { base: string | null };
    if (row.base) { base = JSON.parse(row.base); const cached = bases?.get(thread); previous = cached?.detail === row.base ? cached.request : Buffer.from(rebuild(db, base!, true).request); }
  } catch { base = null; }
  let prefix = 0, suffix = 0;
  if (base) {
    while (prefix < Math.min(request.length, previous.length) && request[prefix] === previous[prefix]) prefix++;
    while (prefix && prefix < request.length && (request[prefix]! & 0xc0) === 0x80) prefix--;
    while (suffix < Math.min(request.length, previous.length) - prefix && request[request.length - suffix - 1] === previous[previous.length - suffix - 1]) suffix++;
    while (suffix && (request[request.length - suffix]! & 0xc0) === 0x80) suffix--;
  }
  const middle = request.subarray(prefix, request.length - suffix);
  const { request: _request, response: _response, frames: _frames, ...metadata } = body;
  const combined = put(Buffer.concat([response, frames]));
  let refs: PieceDetail = { ...metadata, thread, request: merge([...(base ? sliceRanges(base.request, 0, prefix) : []), ...put(middle), ...(base ? sliceRanges(base.request, previous.length - suffix, suffix) : [])]), response: sliceRanges(combined, 0, response.length), frames: sliceRanges(combined, response.length, frames.length) };
  const matches = (candidate: PieceDetail) => {
    const restored = rebuild(db, candidate);
    return ['request', 'response', 'frames'].every((k) => hash(JSON.stringify(restored[k as keyof Body])) === hash(JSON.stringify(body[k as keyof Body])));
  };
  let indexRequest = middle;
  let valid = false;
  try { valid = matches(refs); } catch { /* Full-copy fallback is verified below. */ }
  if (!valid) {
    indexRequest = request;
    const full = put(Buffer.concat([response, frames]));
    refs = { ...refs, request: put(request), response: sliceRanges(full, 0, response.length), frames: sliceRanges(full, response.length, frames.length) };
    if (!matches(refs)) throw new Error('Archive rebuild check failed');
    db.exec(`INSERT INTO archive_meta VALUES('diffFallbacks','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`);
  }
  const detail = JSON.stringify(refs);
  db.prepare('UPDATE archive_entries SET detail=?,stored_bytes=?,thread_id=? WHERE id=?').run(detail, Buffer.byteLength(detail), thread, id);
  db.prepare('UPDATE archive_threads SET base=? WHERE id=?').run(detail, thread);
  refreshThread(db, thread);
  db.prepare('INSERT OR IGNORE INTO archive_search_keys(entry_id) VALUES(?)').run(id);
  db.prepare('UPDATE archive_entries SET search_key=(SELECT id FROM archive_search_keys WHERE entry_id=?) WHERE id=?').run(id, id);
  const key = (db.prepare('SELECT search_key FROM archive_entries WHERE id=?').get(id) as { search_key: number }).search_key;
  db.prepare('DELETE FROM archive_search WHERE rowid=?').run(key);
  const decoded = indexRequest.toString().replace(/\\(?:u[\da-fA-F]{4}|[nrt"\\/bf])/g, (s) => JSON.parse(`"${s}"`));
  db.prepare('INSERT INTO archive_search(rowid,text) VALUES(?,?)').run(key, archiveSearchText(decoded, body.response, body.frames));
  bases?.clear();
  bases?.set(thread, { detail, request });
  return refs;
}
export function refreshThread(db: Db, thread: string): void {
  db.prepare('UPDATE archive_threads SET stored_bytes=(SELECT coalesce(sum(length(bytes)),0) FROM archive_pieces WHERE thread_id=?)+(SELECT coalesce(sum(stored_bytes),0) FROM archive_entries WHERE thread_id=?),logical_bytes=(SELECT coalesce(sum(bytes),0) FROM archive_entries WHERE thread_id=?) WHERE id=?').run(thread, thread, thread, thread);
}
export function migratePieces(db: Db): void {
  db.exec(PIECE_SCHEMA);
  const columns = db.prepare('PRAGMA table_info(archive_entries)').all() as { name: string }[];
  for (const [name, type] of [['thread_id', 'TEXT'], ['stored_bytes', 'INTEGER NOT NULL DEFAULT 0'], ['search_key', 'INTEGER']] as const) if (!columns.some((c) => c.name === name)) db.exec(`ALTER TABLE archive_entries ADD COLUMN ${name} ${type}`);
  db.exec('CREATE INDEX IF NOT EXISTS archive_entry_thread ON archive_entries(thread_id)');
  if (db.prepare("SELECT 1 FROM archive_meta WHERE key='piecesMigrated'").get()) return;
  const bases = new Map<string, { detail: string; request: Buffer }>();
  for (;;) {
    const cursor = db.prepare("SELECT value FROM archive_meta WHERE key='pieceCursor'").get() as { value: string } | undefined;
    const [at, id] = cursor ? JSON.parse(cursor.value) : ['', ''];
    const rows = db.prepare('SELECT id,at,detail FROM archive_entries WHERE (at,id)>(?,?) AND bytes>0 AND thread_id IS NULL ORDER BY at,id LIMIT ?').all(at, id, MIGRATION_BATCH) as { id: string; at: string; detail: string }[];
    if (!rows.length) break;
    db.transaction(() => {
      for (const r of rows) storeBody(db, r.id, JSON.parse(r.detail), bases);
      const last = rows.at(-1)!;
      db.prepare("INSERT OR REPLACE INTO archive_meta VALUES('pieceCursor',?)").run(JSON.stringify([last.at, last.id]));
    })();
  }
  db.exec("DROP TABLE IF EXISTS archive_fts; PRAGMA incremental_vacuum; INSERT OR REPLACE INTO archive_meta VALUES('piecesMigrated','true')");
}
export const collectPieces = (db: Db): void => { db.exec('DELETE FROM archive_pieces WHERE (thread_id IS NULL OR thread_id NOT IN (SELECT id FROM archive_threads)) AND id NOT IN (SELECT piece_id FROM archive_pins)'); };
export const storedBytes = (db: Db): number => (db.prepare('SELECT coalesce(sum(stored_bytes),0) AS n FROM archive_threads').get() as { n: number }).n;
export function expireThread(db: Db, thread: string): void {
  db.prepare('DELETE FROM archive_search WHERE rowid IN (SELECT search_key FROM archive_entries WHERE thread_id=?)').run(thread);
  db.prepare("UPDATE archive_entries SET state='expired',reason='retention-or-byte-budget',bytes=0,stored_bytes=0,detail='{}',thread_id=NULL WHERE thread_id=?").run(thread);
  const expired = db.prepare("SELECT seq,length(CAST(content AS BLOB)) AS content_bytes FROM clickhouse_outbox WHERE thread_id=? AND content IS NOT NULL").all(thread) as { seq: number; content_bytes: number }[];
  for (const r of expired) db.prepare("UPDATE clickhouse_outbox SET bytes=bytes-length(CAST(content AS BLOB)),content=NULL,expired=1 WHERE seq=?").run(r.seq);
  db.prepare('UPDATE clickhouse_export SET queued_bytes=queued_bytes-?').run(expired.reduce((n, r) => n + r.content_bytes, 0));
  db.prepare('UPDATE clickhouse_export SET content_expired=content_expired+?').run(expired.length);
  db.prepare('UPDATE archive_pieces SET thread_id=NULL WHERE thread_id=?').run(thread);
  db.prepare('DELETE FROM archive_threads WHERE id=?').run(thread); collectPieces(db);
}

