import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { CAPTURE_BODY_LIMIT, CAPTURE_CHUNK_BYTES, DEFAULT_ARCHIVE_POLICY, type CaptureRecord } from '@shared/archive';
import { CLICKHOUSE_BATCH_BYTES, DEFAULT_CLICKHOUSE_CONFIG } from '@shared/clickhouse';
import { durableTransaction, openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
import { ClickHouseStore } from './clickhouseStore';
import { pieceBytes } from './archivePieces';
import { ArchiveExporter } from './archiveExport';

const dirs: string[] = [], dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-wire-')); dirs.push(dir);
  const key = randomBytes(32).toString('hex'), file = path.join(dir, 'activity.db'), db = openActivityDb(file, key); dbs.push(db);
  let exporter: ClickHouseStore;
  const archive = new ArchiveStore(db, { append: (f) => exporter.append(f) }); exporter = new ClickHouseStore(db, archive);
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  return { db, archive, exporter, file, key };
}
function stream(request: Buffer, response: Buffer, options: { messages?: number; encoding?: string } = {}): CaptureRecord[] {
  const base: CaptureRecord = { id: 'capture-wire', traceId: 'trace-wire-complete', epoch: 'wire-epoch', sequence: 1, startedAt: new Date().toISOString(), method: 'POST', path: '/v1/responses', status: 200, state: 'pending', reason: 'capture-open', request: '', response: '', requestType: 'application/json', responseType: 'text/event-stream', requestEncoding: options.encoding ?? '', responseEncoding: '', format: options.messages ? 'websocket' : 'http', requestBytes: 0, responseBytes: 0, frameCount: 0, requestSha256: '', responseSha256: '' };
  const out: CaptureRecord[] = [{ ...base, event: 'start' }];
  const counts = { request: 0, response: 0 }; let frame = 0;
  for (const [direction, payload] of [['request', request], ['response', response]] as const) {
    const size = options.messages && direction === 'response' ? response.length / options.messages : payload.length;
    const messages = options.messages ? direction === 'response' ? options.messages : 1 : 1;
    for (let m = 0; m < messages; m++) {
      if (options.messages) frame++;
      const body = payload.subarray(m * size, (m + 1) * size);
      for (let offset = 0; offset < body.length || offset === 0 && options.messages; offset += CAPTURE_CHUNK_BYTES) {
        const bytes = body.subarray(offset, offset + CAPTURE_CHUNK_BYTES), at = counts[direction]; counts[direction] += bytes.length;
        out.push({ ...base, event: 'data', sequence: out.length + 1, requestBytes: counts.request, responseBytes: counts.response, frameCount: frame, chunk: { direction, offset: at, data: bytes.toString('base64'), frame, type: options.messages ? 'binary' : '', at: options.messages ? base.startedAt : '', end: Boolean(options.messages && offset + bytes.length === body.length) } });
      }
    }
  }
  out.push({ ...base, event: 'end', state: 'complete', reason: 'finalized', sequence: out.length + 1, requestBytes: request.length, responseBytes: response.length, frameCount: frame, requestSha256: createHash('sha256').update(request).digest('hex'), responseSha256: createHash('sha256').update(response).digest('hex') });
  return out;
}
function ingest(archive: ArchiveStore, records: CaptureRecord[]): void {
  for (let i = 0; i < records.length; i += 4) archive.ingest({ version: 2, epoch: records[i]!.epoch, dropped: 0, records: records.slice(i, i + 4) });
}
function wireBytes(db: Db, direction: string): Buffer {
  return Buffer.concat((db.prepare('SELECT piece_id FROM archive_wire WHERE direction=? ORDER BY sequence').all(direction) as { piece_id: number | null }[]).map((r) => r.piece_id === null ? Buffer.alloc(0) : pieceBytes(db, r.piece_id)));
}
it('stores complete binary bodies beyond the old cap in encrypted bounded pieces', () => {
  const { db, archive, file } = setup(), request = randomBytes(CAPTURE_BODY_LIMIT + CAPTURE_CHUNK_BYTES), response = Buffer.from([0xff, 0, 0xfe]);
  const records = stream(request, response); ingest(archive, records); ingest(archive, records);
  expect(wireBytes(db, 'request').equals(request)).toBe(true); expect(wireBytes(db, 'response').equals(response)).toBe(true);
  expect(archive.detail('trace-wire-complete')).toMatchObject({ state: 'complete', previewOnly: true });
  for (const row of db.prepare('SELECT id FROM archive_pieces').all() as { id: number }[]) expect(pieceBytes(db, row.id).length).toBeLessThanOrEqual(CAPTURE_CHUNK_BYTES);
  db.pragma('wal_checkpoint(TRUNCATE)'); expect(readFileSync(file).includes(request.subarray(0, 256))).toBe(false);
});
it('retains more than 128 binary WebSocket messages without replacing bytes', () => {
  const { db, archive } = setup(), request = Buffer.from('request'), response = randomBytes(300 * 9);
  ingest(archive, stream(request, response, { messages: 300 }));
  expect(wireBytes(db, 'response').equals(response)).toBe(true);
  expect(db.prepare('SELECT count(DISTINCT frame_index) AS n FROM archive_wire').get()).toEqual({ n: 301 });
  expect(archive.detail('trace-wire-complete')?.state).toBe('complete');
});
it('preserves compressed wire bytes while showing a decoded small preview', () => {
  const { db, archive } = setup(), request = gzipSync(Buffer.from('{"input":"compressed request"}'));
  ingest(archive, stream(request, Buffer.from('ok'), { encoding: 'gzip' }));
  expect(wireBytes(db, 'request').equals(request)).toBe(true);
  expect(archive.detail('trace-wire-complete')).toMatchObject({ request: '{"input":"compressed request"}', requestDecoded: true, state: 'complete' });
});
it('accepts the HTTP response body of a failed WebSocket upgrade', () => {
  const { archive } = setup(), records = stream(Buffer.alloc(0), Buffer.from('bad upgrade'));
  records[0]!.format = 'websocket';
  ingest(archive, records);
  expect(archive.detail('trace-wire-complete')).toMatchObject({ state: 'complete', format: 'http', response: 'bad upgrade' });
});
it('finalizes orphaned pending wire captures when a different journal epoch appears', () => {
  const { archive } = setup(); ingest(archive, stream(Buffer.from('abc'), Buffer.from('def')).slice(0, 2));
  archive.ingest({ version: 2, epoch: 'replacement-epoch', dropped: 0, records: [] });
  expect(archive.detail('trace-wire-complete')).toMatchObject({ state: 'partial', reason: 'capture-journal-reset' });
});
it('indexes message continuation lookups and accounts for a long capture incrementally', () => {
  const { db, archive } = setup();
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT direction,frame_type,frame_at,frame_end FROM archive_wire WHERE entry_id=? AND frame_index=? ORDER BY sequence DESC LIMIT 1').all('entry', 1) as { detail: string }[];
  expect(plan.some((p) => p.detail.includes('archive_wire_frame'))).toBe(true);
  const messages = 20_000, request = Buffer.from('x'), response = randomBytes(messages);
  durableTransaction(db, () => ingest(archive, stream(request, response, { messages })));
  expect(wireBytes(db, 'response').equals(response)).toBe(true);
  const totals = db.prepare('SELECT coalesce((SELECT sum(length(bytes)) FROM archive_pieces),0)+(SELECT sum(stored_bytes) FROM archive_entries) AS bytes').get() as { bytes: number };
  expect(archive.status()).toMatchObject({ storedBytes: totals.bytes, bytes: request.length + response.length });
}, 30_000);
it('rolls back invalid offsets, gaps and terminal digests before acknowledging the cursor', () => {
  const { db, archive } = setup(), records = stream(Buffer.from('abc'), Buffer.from('def'));
  ingest(archive, records.slice(0, 1));
  const bad = { ...records[1]!, chunk: { ...records[1]!.chunk!, offset: 1 } };
  expect(() => ingest(archive, [bad])).toThrow(/offset/); expect(archive.status().sequence).toBe(1); expect(wireBytes(db, 'request').length).toBe(0);
  expect(() => ingest(archive, [records[2]!])).toThrow(/gap/); ingest(archive, records.slice(1, -1));
  expect(() => ingest(archive, [{ ...records.at(-1)!, requestSha256: createHash('sha256').update('wrong').digest('hex') }])).toThrow(/digest/);
  expect(archive.detail('trace-wire-complete')?.state).toBe('pending'); ingest(archive, records.slice(-1));
  expect(archive.detail('trace-wire-complete')?.state).toBe('complete');
});
it('synchronizes capture commits without changing ordinary Activity durability', () => {
  const { db } = setup(), modes: number[] = [];
  const archive = new ArchiveStore(db, { append: () => modes.push(Number(db.pragma('synchronous', { simple: true }))) });
  const normal = Number(db.pragma('synchronous', { simple: true }));
  ingest(archive, stream(Buffer.from('abc'), Buffer.from('def')));
  expect([...new Set(modes)]).toEqual([2]); expect(Number(db.pragma('synchronous', { simple: true }))).toBe(normal);
  expect(() => db.transaction(() => ingest(archive, stream(Buffer.from('abc'), Buffer.from('def'))))()).toThrow('durable outer transaction');
});
it('fences late pages after an offline local deletion', () => {
  const { archive } = setup(), records = stream(Buffer.from('abc'), Buffer.from('def'));
  ingest(archive, records); archive.clear();
  expect(() => ingest(archive, records)).toThrow('deletion is pending'); expect(archive.status().entries).toBe(0);
  archive.clearAcknowledged(); ingest(archive, records); expect(archive.status().entries).toBe(0);
});
it('resumes an open stream after a worker restart and imports already-captured bytes when recording is disabled', () => {
  const { db, archive, file, key } = setup(), records = stream(Buffer.from('abc'), Buffer.from('def'));
  ingest(archive, records.slice(0, 2)); db.close();
  const reopened = openActivityDb(file, key); dbs.push(reopened);
  const restored = new ArchiveStore(reopened); restored.setPolicy(DEFAULT_ARCHIVE_POLICY);
  ingest(restored, records.slice(2)); expect(restored.detail('trace-wire-complete')).toMatchObject({ request: 'abc', response: 'def', state: 'complete' });
});
it('exports large bodies over bounded batches and retains queued content across retention and recording disable', () => {
  const { db, archive, exporter } = setup(), request = randomBytes(CAPTURE_BODY_LIMIT + CAPTURE_CHUNK_BYTES), response = randomBytes(1024);
  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: 'http://127.0.0.1:8123' }); exporter.prepare();
  ingest(archive, stream(request, response)); archive.setPolicy(DEFAULT_ARCHIVE_POLICY);
  archive.prune(Date.now() + 8 * 86_400_000, true); expect(archive.detail('trace-wire-complete')?.state).toBe('complete');
  const pieces = new Map<number, string>(); const facts: { kind: string; content_policy: string; record_json: string; request_pieces: { piece_seq: number; offset: number; length: number }[] }[] = [];
  let batches = 0;
  for (;;) {
    const batch = exporter.prepare(); if (!batch) break;
    expect(Buffer.byteLength(batch.facts + batch.pieces)).toBeLessThanOrEqual(CLICKHOUSE_BATCH_BYTES);
    for (const line of batch.pieces.trim().split('\n').filter(Boolean)) { const row = JSON.parse(line); pieces.set(row.seq, row.bytes); }
    for (const line of batch.facts.trim().split('\n').filter(Boolean)) facts.push(JSON.parse(line));
    exporter.acknowledge(batch.token, batch.destination); batches++;
  }
  expect(batches).toBeGreaterThan(1);
  const chunks = facts.filter((r) => r.kind === 'capture-chunk' && JSON.parse(r.record_json).chunk.direction === 'request');
  expect(chunks.every((r) => r.content_policy === 'included')).toBe(true);
  const restored = Buffer.concat(chunks.map((r) => Buffer.from(r.request_pieces.map((p) => pieces.get(p.piece_seq)!.slice(p.offset, p.offset + p.length)).join(''), 'base64')));
  expect(restored.equals(request)).toBe(true); expect(facts.at(-1)?.kind).toBe('capture-end');
  expect(exporter.status()).toMatchObject({ queued: 0, discarded: 0, contentExpired: 0 });
  archive.prune(Date.now() + 8 * 86_400_000, true); expect(archive.detail('trace-wire-complete')?.state).toBe('expired');
  expect(db.prepare('SELECT count(*) AS n FROM archive_wire').get()).toEqual({ n: 0 });
});
it('backfills every raw chunk to a new destination without reconstructing the whole body', () => {
  const { archive, exporter } = setup(), request = randomBytes(CAPTURE_CHUNK_BYTES * 2);
  ingest(archive, stream(request, Buffer.from('ok')));
  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: 'http://127.0.0.1:8123' });
  const batch = exporter.prepare()!;
  const facts = batch.facts.trim().split('\n').map((s) => JSON.parse(s));
  expect(facts.filter((r) => r.kind === 'capture-chunk')).toHaveLength(3);
  expect(facts.at(-1)).toMatchObject({ kind: 'capture-end', capture_state: 'complete' });
  exporter.acknowledge(batch.token, batch.destination); expect(exporter.prepare()).toBeNull();
});
it('resets an in-progress backfill cursor when its previous entry was deleted', () => {
  const { db, archive, exporter } = setup();
  const old = stream(Buffer.from('old'), Buffer.from('old')).map((r) => ({ ...r, startedAt: new Date(Date.now() - 1000).toISOString() })); ingest(archive, old);
  const next = stream(Buffer.from('new'), Buffer.from('new')).map((r) => ({ ...r, id: 'capture-next', traceId: 'trace-wire-next', epoch: 'next-epoch' })); ingest(archive, next);
  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: false, endpoint: 'http://127.0.0.1:8123' });
  db.prepare('UPDATE clickhouse_export SET backfill_cursor=?').run(JSON.stringify([old[0]!.startedAt, 'trace:trace-wire-complete', 5]));
  db.prepare('DELETE FROM archive_entries WHERE trace_id=?').run('trace-wire-complete');
  const facts = exporter.prepare()!.facts.trim().split('\n').map((s) => JSON.parse(s));
  expect(facts.map((r) => r.kind)).toEqual(['capture-start', 'capture-chunk', 'capture-chunk', 'capture-end']);
});
it('exports frozen complete wire bytes rather than bounded display previews', async () => {
  const { db, archive, file } = setup(), request = randomBytes(CAPTURE_BODY_LIMIT + CAPTURE_CHUNK_BYTES);
  ingest(archive, stream(request, Buffer.from('ok')));
  const exporter = new ArchiveExporter(db, archive);
  try {
    const job = exporter.prepare({ includeRecordedBodies: true }); expect(job.manifest.version).toBe(2);
    archive.clear();
    const destination = path.join(path.dirname(file), 'wire.jsonl'); exporter.start(job.id, destination);
    await vi.waitFor(() => expect(exporter.status(job.id).state).toBe('complete'), { timeout: 10_000 });
    const lines = readFileSync(destination, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    const restored = Buffer.concat(lines.filter((r) => r.type === 'wire-chunk' && r.direction === 'request').map((r) => Buffer.from(r.data, 'base64')));
    expect(restored.equals(request)).toBe(true); expect(lines.filter((r) => r.type === 'wire-end')).toHaveLength(1);
    const bytes = readFileSync(destination), trailer = lines.at(-1)!;
    expect(createHash('sha256').update(bytes.subarray(0, trailer.bytesBeforeTrailer)).digest('hex')).toBe(trailer.sha256);
  } finally { await exporter.dispose(); }
});
