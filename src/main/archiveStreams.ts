import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants, gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { CAPTURE_BODY_LIMIT, CAPTURE_CHUNK_BYTES, type CaptureRecord, type ArchiveDetail } from '@shared/archive';
import type { Db } from './activityDb';
import type { ArchiveFactSink } from './archiveStore';
import { pieceBytes, type Range, type Body } from './archivePieces';
import { archiveSearchText } from '@shared/archiveContent';

export const WIRE_SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_wire(entry_id TEXT NOT NULL,sequence INTEGER NOT NULL,piece_id INTEGER,direction TEXT NOT NULL,offset INTEGER NOT NULL,frame_index INTEGER NOT NULL,frame_type TEXT NOT NULL,frame_at TEXT NOT NULL,frame_end INTEGER NOT NULL,PRIMARY KEY(entry_id,sequence));
CREATE INDEX IF NOT EXISTS archive_wire_piece ON archive_wire(piece_id);
CREATE INDEX IF NOT EXISTS archive_wire_frame ON archive_wire(entry_id,frame_index,sequence DESC);
`;
export interface WireContent { wire: 2; thread: string; request: Range[] }
export interface WireDetail {
  wire: 2; entryId: string; firstSequence: number; requestType: string; responseType: string; requestEncoding: string; responseEncoding: string; format: 'http' | 'websocket';
  requestBytes: number; responseBytes: number; frameCount: number; requestSha256: string; responseSha256: string;
}
type WireRow = { piece_id: number | null; direction: 'request' | 'response'; offset: number; frame_index: number; frame_type: 'text' | 'binary'; frame_at: string; frame_end: number };
const TRACE = /^[a-zA-Z0-9_-]{8,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const date = (s: unknown): s is string => typeof s === 'string' && s.length <= 64 && Number.isFinite(Date.parse(s));
const uint = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const metadata = (r: CaptureRecord, firstSequence = r.sequence): WireDetail => ({ wire: 2, entryId: `trace:${r.traceId}`, firstSequence, requestType: r.requestType, responseType: r.responseType, requestEncoding: r.requestEncoding, responseEncoding: r.responseEncoding, format: r.format === 'websocket' ? 'websocket' : 'http', requestBytes: r.requestBytes!, responseBytes: r.responseBytes!, frameCount: r.frameCount!, requestSha256: r.requestSha256 ?? '', responseSha256: r.responseSha256 ?? '' });
export function ingestWire(db: Db, r: CaptureRecord, sink?: ArchiveFactSink): void {
  if (typeof r.traceId !== 'string' || !TRACE.test(r.traceId) || typeof r.id !== 'string' || !r.id || r.id.length > 128 || !date(r.startedAt) || !['http', 'websocket'].includes(r.format ?? '') || !['start', 'data', 'end'].includes(r.event ?? '') || !['requestBytes', 'responseBytes', 'frameCount'].every((k) => uint(r[k as keyof CaptureRecord])) || !['method', 'path', 'reason', 'requestType', 'responseType', 'requestEncoding', 'responseEncoding'].every((k) => typeof r[k as keyof CaptureRecord] === 'string' && Buffer.byteLength(String(r[k as keyof CaptureRecord])) <= 8192)) throw new Error('Invalid capture stream metadata');
  const id = `trace:${r.traceId}`, thread = JSON.stringify(['wire', r.epoch, r.id]);
  let firstSequence = r.sequence;
  const before = db.prepare('SELECT detail,capture_id,capture_epoch,state,stored_bytes FROM archive_entries WHERE id=?').get(id) as { detail: string; capture_id: string; capture_epoch: string; state: string; stored_bytes: number } | undefined;
  if (r.event === 'start') {
    if (r.requestBytes || r.responseBytes || r.frameCount || r.chunk) throw new Error('Invalid capture start');
    db.prepare(`INSERT INTO archive_entries(id,trace_id,at,state,reason,capture_id,capture_epoch,capture_sequence,method,path,status,detail,thread_id) VALUES(?,?,?,'pending','capture-open',?,?,?,?,?,?,?,?)
      ON CONFLICT(trace_id) DO UPDATE SET state='pending',reason='capture-open',capture_id=excluded.capture_id,capture_epoch=excluded.capture_epoch,capture_sequence=excluded.capture_sequence,detail=excluded.detail,thread_id=excluded.thread_id,method=excluded.method,path=excluded.path`).run(id, r.traceId, r.startedAt, r.id, r.epoch, r.sequence, r.method, r.path, r.status, JSON.stringify(metadata(r)), thread);
    db.prepare('INSERT OR IGNORE INTO archive_threads(id,first_at,last_at) VALUES(?,?,?)').run(thread, r.startedAt, r.startedAt);
  } else {
    if (!before || before.capture_id !== r.id || before.capture_epoch !== r.epoch) throw new Error('Capture stream start is unavailable');
    const prior = JSON.parse(before.detail) as WireDetail;
    firstSequence = prior.firstSequence;
    if (prior.wire !== 2) throw new Error('Invalid capture stream owner');
    if (r.event === 'data') {
      const c = r.chunk;
      if (!c || !['request', 'response'].includes(c.direction) || !uint(c.offset) || !uint(c.frame) || typeof c.end !== 'boolean' || typeof c.data !== 'string' || c.data.length > Math.ceil(CAPTURE_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(c.data)) throw new Error('Invalid capture chunk');
      const bytes = Buffer.from(c.data, 'base64');
      if (bytes.length > CAPTURE_CHUNK_BYTES || bytes.toString('base64') !== c.data || c.offset !== prior[`${c.direction}Bytes`]) throw new Error('Capture chunk offset mismatch');
      const expected = { ...prior, [`${c.direction}Bytes`]: c.offset + bytes.length, frameCount: Math.max(prior.frameCount, c.frame) };
      if (r.requestBytes !== expected.requestBytes || r.responseBytes !== expected.responseBytes || r.frameCount !== expected.frameCount) throw new Error('Capture chunk byte count mismatch');
      if (c.frame ? !['text', 'binary'].includes(c.type) || !date(c.at) : c.type !== '' || c.end) throw new Error('Invalid capture message boundary');
      if (c.frame) {
        const previous = db.prepare('SELECT direction,frame_type,frame_at,frame_end AS ended FROM archive_wire WHERE entry_id=? AND frame_index=? ORDER BY sequence DESC LIMIT 1').get(id, c.frame) as { direction: string; frame_type: string; frame_at: string; ended: number } | undefined;
        if (previous && (previous.ended || previous.direction !== c.direction || previous.frame_type !== c.type || previous.frame_at !== c.at)) throw new Error('Invalid capture message continuation');
      }
      const compressed = bytes.length ? zstdCompressSync(bytes) : null;
      const piece = compressed ? Number(db.prepare('INSERT INTO archive_pieces(thread_id,bytes) VALUES(?,?)').run(thread, compressed).lastInsertRowid) : null;
      db.prepare('INSERT INTO archive_wire VALUES(?,?,?,?,?,?,?,?,?)').run(id, r.sequence, piece, c.direction, c.offset, c.frame, c.type, c.at, Number(c.end));
      db.prepare("UPDATE archive_entries SET state='pending',reason='capture-open',bytes=?,stored_bytes=?,detail=?,capture_sequence=? WHERE id=?").run(expected.requestBytes + expected.responseBytes, Buffer.byteLength(JSON.stringify(expected)), JSON.stringify(expected), r.sequence, id);
      db.prepare('UPDATE archive_threads SET stored_bytes=stored_bytes+?,logical_bytes=logical_bytes+? WHERE id=?').run((compressed?.length ?? 0) + Buffer.byteLength(JSON.stringify(expected)) - before.stored_bytes, bytes.length, thread);
      const { data: _data, ...chunk } = c;
      const content: WireContent = { wire: 2, thread, request: piece ? [[piece, 0, bytes.length]] : [] };
      sink?.append({ kind: 'capture-chunk', traceId: r.traceId, at: r.startedAt, captureState: 'pending', record: { captureId: r.id, epoch: r.epoch, sequence: r.sequence, chunk, representation: 'base64-wire-v2', rawBytes: bytes.length }, content });
      return;
    }
    if (r.chunk || !['complete', 'partial', 'missing'].includes(r.state) || r.requestBytes !== prior.requestBytes || r.responseBytes !== prior.responseBytes || r.frameCount !== prior.frameCount) throw new Error('Capture terminal byte count mismatch');
    if (r.state === 'complete' || r.requestSha256 || r.responseSha256) {
      for (const direction of ['request', 'response'] as const) {
        const expected = r[`${direction}Sha256`];
        const hash = createHash('sha256');
        for (const row of db.prepare('SELECT piece_id FROM archive_wire WHERE entry_id=? AND direction=? ORDER BY sequence').iterate(id, direction) as Iterable<{ piece_id: number | null }>) if (row.piece_id !== null) hash.update(pieceBytes(db, row.piece_id));
        if (!expected || !HASH.test(expected) || hash.digest('hex') !== expected) throw new Error('Capture terminal digest mismatch');
      }
    }
    if (r.state === 'complete' && r.format === 'websocket') {
      const frames = db.prepare('SELECT count(DISTINCT frame_index) AS n,coalesce(sum(frame_end),0) AS ended,coalesce(max(frame_index),0) AS last FROM archive_wire WHERE entry_id=? AND frame_index>0').get(id) as { n: number; ended: number; last: number };
      if (frames.n !== r.frameCount || frames.ended !== frames.n || frames.last !== frames.n) throw new Error('Incomplete capture messages');
    }
    db.prepare('UPDATE archive_entries SET state=?,reason=?,detail=?,stored_bytes=?,status=?,capture_sequence=? WHERE id=?').run(r.state, r.reason, JSON.stringify(metadata(r, prior.firstSequence)), Buffer.byteLength(JSON.stringify(metadata(r, prior.firstSequence))), r.status, r.sequence, id);
    db.prepare('UPDATE archive_threads SET stored_bytes=stored_bytes+? WHERE id=?').run(Buffer.byteLength(JSON.stringify(metadata(r, prior.firstSequence))) - before.stored_bytes, thread);
    indexWire(db, id, metadata(r, prior.firstSequence));
  }
  sink?.append({ kind: r.event === 'start' ? 'capture-start' : 'capture-end', traceId: r.traceId, at: r.startedAt, captureState: r.state, record: { ...metadata(r, firstSequence), captureId: r.id, epoch: r.epoch, sequence: r.sequence, method: r.method, path: r.path, status: r.status, state: r.state, reason: r.reason }, content: null });
}

function decodedPreview(bytes: Buffer, encoding: string): { text: string; decoded: boolean; limited: boolean } {
  try {
    let decoded = bytes;
    for (const name of encoding.toLowerCase().split(',').reverse().map((s) => s.trim())) {
      if (name === 'gzip' || name === 'x-gzip') decoded = gunzipSync(decoded, { maxOutputLength: CAPTURE_BODY_LIMIT, finishFlush: constants.Z_SYNC_FLUSH });
      else if (name === 'zstd') decoded = zstdDecompressSync(decoded, { maxOutputLength: CAPTURE_BODY_LIMIT });
      else if (name && name !== 'identity') throw new Error('unsupported encoding');
    }
    if (isUtf8(decoded)) return { text: decoded.toString(), decoded: true, limited: false };
  } catch { /* Original bytes remain lossless; decoding only affects the preview. */ }
  return { text: 'Base64 wire body:\n' + bytes.toString('base64'), decoded: false, limited: Boolean(encoding) };
}
/** UI and search previews are bounded independently of retained wire bytes. */
export function readWireBody(db: Db, id: string, detail: WireDetail): Body & Pick<ArchiveDetail, 'previewOnly'> {
  const buffers = { request: Buffer.alloc(Math.min(detail.requestBytes, CAPTURE_BODY_LIMIT)), response: Buffer.alloc(Math.min(detail.responseBytes, CAPTURE_BODY_LIMIT)) }, sizes = { request: 0, response: 0 };
  // Message previews stop at the former diagnostic count; storage and export retain every message.
  const PREVIEW_MESSAGES = 128;
  const frames = new Map<number, { row: WireRow; buffers: Buffer[] }>();
  for (const row of db.prepare('SELECT * FROM archive_wire WHERE entry_id=? ORDER BY sequence').iterate(id) as Iterable<WireRow>) {
    if (row.frame_index && !frames.has(row.frame_index) && frames.size === PREVIEW_MESSAGES) break;
    const direction = row.direction, remaining = buffers[direction].length - sizes[direction];
    if (remaining <= 0 && !row.frame_index) continue;
    const bytes = row.piece_id === null ? Buffer.alloc(0) : pieceBytes(db, row.piece_id).subarray(0, Math.max(0, remaining));
    bytes.copy(buffers[direction], sizes[direction]); sizes[direction] += bytes.length;
    if (row.frame_index) {
      const frame = frames.get(row.frame_index) ?? { row, buffers: [] };
      frame.buffers.push(bytes); frames.set(row.frame_index, frame);
    }
    if (sizes.request === buffers.request.length && sizes.response === buffers.response.length && (detail.format === 'http' || detail.requestBytes > CAPTURE_BODY_LIMIT || detail.responseBytes > CAPTURE_BODY_LIMIT || frames.size >= Math.min(detail.frameCount, PREVIEW_MESSAGES))) break;
  }
  const request = decodedPreview(buffers.request.subarray(0, sizes.request), detail.requestEncoding), response = decodedPreview(buffers.response.subarray(0, sizes.response), detail.responseEncoding);
  return { request: request.text, response: response.text, frames: [...frames].sort(([a], [b]) => a - b).map(([index, f]) => ({ index, direction: f.row.direction, type: f.row.frame_type, at: f.row.frame_at, payload: decodedPreview(Buffer.concat(f.buffers), '').text, truncated: false })),
    requestCut: null, responseCut: null, requestType: detail.requestType, responseType: detail.responseType, requestEncoding: detail.requestEncoding, responseEncoding: detail.responseEncoding, requestDecoded: request.decoded, responseDecoded: response.decoded, format: detail.format,
    previewOnly: frames.size < detail.frameCount || sizes.request < detail.requestBytes || sizes.response < detail.responseBytes || request.limited || response.limited };
}
function indexWire(db: Db, id: string, detail: WireDetail): void {
  const body = readWireBody(db, id, detail);
  db.prepare('INSERT OR IGNORE INTO archive_search_keys(entry_id) VALUES(?)').run(id);
  const key = (db.prepare('SELECT id FROM archive_search_keys WHERE entry_id=?').get(id) as { id: number }).id;
  db.prepare('UPDATE archive_entries SET search_key=? WHERE id=?').run(key, id);
  db.prepare('DELETE FROM archive_search WHERE rowid=?').run(key);
  db.prepare('INSERT INTO archive_search(rowid,text) VALUES(?,?)').run(key, archiveSearchText(body.request, body.response, body.frames));
}
