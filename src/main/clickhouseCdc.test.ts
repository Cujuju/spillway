import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CAPTURE_CHUNK_BYTES, DEFAULT_ARCHIVE_POLICY, type CaptureRecord } from '@shared/archive';
import { CLICKHOUSE_BATCH_BYTES, DEFAULT_CLICKHOUSE_CONFIG } from '@shared/clickhouse';
import { startDemoClickHouse } from '../../scripts/demo/clickhouse.mts';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
import { CDC_MAX_BYTES, CDC_MIN_BYTES, FastCdcChunker, chunkBytes } from './clickhouseCdc';
import { ClickHouseStore } from './clickhouseStore';
import { ClickHouseUploader } from './clickhouseUploader';
import { CDC_PIECE_THREAD, CLICKHOUSE_CDC_WIRE, CLICKHOUSE_CDC_WIRE_VERSION, cdcPieceSequence, rawPieceSequence, type CdcFrameBoundary } from './clickhouseWire';

const dirs: string[] = [], dbs: Db[] = [], servers: Awaited<ReturnType<typeof startDemoClickHouse>>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-cdc-'));
  dirs.push(dir);
  const db = openActivityDb(path.join(dir, 'activity.db'), randomBytes(32).toString('hex'));
  dbs.push(db);
  let exporter: ClickHouseStore;
  const archive = new ArchiveStore(db, {
    append: (f) => exporter.append(f),
    rawWireEnabled: () => exporter.rawWireEnabled(),
    cdcWireEnabled: () => exporter.cdcWireEnabled(),
    cdcExportMode: () => exporter.cdcExportMode(),
  });
  exporter = new ClickHouseStore(db, archive);
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  return { db, archive, exporter };
}

function wireStream(
  id: string,
  traceId: string,
  startSeq: number,
  request: Buffer,
  response: Buffer,
  options: { messages?: number; emptyFrame?: boolean } = {},
): CaptureRecord[] {
  const startedAt = new Date().toISOString();
  const base: CaptureRecord = {
    id, traceId, epoch: 'cdc-epoch', sequence: startSeq, startedAt, method: 'POST', path: '/v1/messages', status: 200,
    state: 'pending', reason: 'capture-open', request: '', response: '', requestType: 'application/json', responseType: 'text/event-stream',
    requestEncoding: '', responseEncoding: '', format: options.messages ? 'websocket' : 'http',
    requestBytes: 0, responseBytes: 0, frameCount: 0, requestSha256: '', responseSha256: '',
  };
  const out: CaptureRecord[] = [{ ...base, event: 'start' }];
  const counts = { request: 0, response: 0 };
  let frame = 0;
  for (const [direction, payload] of [['request', request], ['response', response]] as const) {
    const isWs = Boolean(options.messages);
    const messages = isWs && direction === 'response' ? options.messages! : 1;
    const step = isWs && direction === 'response' ? Math.floor(response.length / messages) : payload.length;
    for (let m = 0; m < messages; m++) {
      if (isWs) frame++;
      const body = isWs && direction === 'response'
        ? (options.emptyFrame && m === 1 ? Buffer.alloc(0) : payload.subarray(m * step, m === messages - 1 ? payload.length : (m + 1) * step))
        : payload;
      for (let offset = 0; offset < body.length || (offset === 0 && isWs); offset += CAPTURE_CHUNK_BYTES) {
        const bytes = body.subarray(offset, offset + CAPTURE_CHUNK_BYTES);
        const at = counts[direction];
        counts[direction] += bytes.length;
        out.push({
          ...base, event: 'data', sequence: startSeq + out.length, requestBytes: counts.request, responseBytes: counts.response, frameCount: frame,
          chunk: { direction, offset: at, data: bytes.toString('base64'), frame, type: isWs ? 'binary' : '', at: isWs ? startedAt : '', end: Boolean(isWs && offset + bytes.length === body.length) },
        });
      }
    }
  }
  const actualResponse = options.messages && options.emptyFrame
    ? Buffer.concat(out.filter((r) => r.event === 'data' && r.chunk?.direction === 'response').map((r) => Buffer.from(r.chunk!.data, 'base64')))
    : response;
  out.push({
    ...base, event: 'end', state: 'complete', reason: 'finalized', sequence: startSeq + out.length,
    requestBytes: request.length, responseBytes: actualResponse.length, frameCount: frame,
    requestSha256: createHash('sha256').update(request).digest('hex'),
    responseSha256: createHash('sha256').update(actualResponse).digest('hex'),
  });
  return out;
}

function ingest(archive: ArchiveStore, records: CaptureRecord[]): void {
  for (let i = 0; i < records.length; i += 4) {
    archive.ingest({ version: 2, epoch: records[i]!.epoch, dropped: 0, records: records.slice(i, i + 4) });
  }
}

function makeUploader(exporter: ClickHouseStore) {
  return new ClickHouseUploader({
    status: async () => exporter.status(),
    prepare: async () => structuredClone(exporter.prepare()),
    acknowledge: async (t, d) => exporter.acknowledge(t, d),
    fail: async (t, n, e) => exporter.fail(t, n, e),
  }, () => undefined);
}

it('streams FastCDC identically to one-shot chunking regardless of slice boundaries', () => {
  const payload = randomBytes(200 * 1024);
  const expected = chunkBytes(payload);
  expect(Buffer.concat(expected).equals(payload)).toBe(true);
  for (let i = 0; i < expected.length - 1; i++) {
    expect(expected[i]!.length).toBeGreaterThanOrEqual(CDC_MIN_BYTES);
    expect(expected[i]!.length).toBeLessThanOrEqual(CDC_MAX_BYTES);
  }
  for (const sliceSize of [1, 37, 4096, 65536]) {
    const streamed: Buffer[] = [];
    const chunker = new FastCdcChunker();
    for (let i = 0; i < payload.length; i += sliceSize) {
      chunker.push(payload.subarray(i, i + sliceSize), (c) => streamed.push(c));
    }
    chunker.finish((c) => streamed.push(c));
    expect(streamed.map((b) => b.length)).toEqual(expected.map((b) => b.length));
    expect(Buffer.concat(streamed).equals(payload)).toBe(true);
  }
});

it('reserves a bit-62 namespace for CDC chunks disjoint from v3 and v4 piece IDs', () => {
  const cdcBit = 1n << 62n;
  expect(cdcPieceSequence(1)).toBe(cdcBit | 1n);
  expect(cdcPieceSequence(1)).not.toBe(rawPieceSequence(1));
  expect((cdcPieceSequence(1) & (1n << 63n))).toBe(0n);
  for (const bad of [0n, -1n, cdcBit, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => cdcPieceSequence(bad)).toThrow('Invalid local ClickHouse CDC chunk ID');
  }
});

it('deduplicates shared request context across captures, frees local chunk bytes on ack, and reconstructs byte-exact', async () => {
  const { db, archive, exporter } = setup();
  const fake = await startDemoClickHouse();
  servers.push(fake);
  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: fake.endpoint });
  exporter.prepare();

  const sharedHistory = randomBytes(180 * 1024);
  const turn1Req = Buffer.concat([sharedHistory, Buffer.from('\n{"role":"user","content":"turn 1"}')]);
  const turn1Res = Buffer.from('{"reply":"answer 1"}');
  const turn2Req = Buffer.concat([sharedHistory, Buffer.from('\n{"role":"user","content":"turn 1"}\n{"role":"user","content":"turn 2"}')]);
  const turn2Res = Buffer.from('{"reply":"answer 2"}');

  const rec1 = wireStream('cap-1', 'trace-cdc-turn-1', 1, turn1Req, turn1Res);
  ingest(archive, rec1);
  const up = makeUploader(exporter);
  while (await up.runOnce()) { /* drain */ }

  const piecesAfterTurn1 = fake.pieces.size;
  expect(piecesAfterTurn1).toBeGreaterThan(5);
  expect([...fake.pieces.values()].every((p) => p.thread_id === CDC_PIECE_THREAD)).toBe(true);
  // Acknowledged chunks free their compressed bytes while keeping the hash index.
  expect(db.prepare('SELECT count(*) AS n FROM clickhouse_cdc_chunks WHERE sent=1 AND bytes IS NULL').get()).toEqual({ n: piecesAfterTurn1 });

  const rec2 = wireStream('cap-2', 'trace-cdc-turn-2', rec1.length + 1, turn2Req, turn2Res);
  ingest(archive, rec2);
  while (await up.runOnce()) { /* drain */ }

  const newPiecesForTurn2 = fake.pieces.size - piecesAfterTurn1;
  // Nearly all of sharedHistory was reused; only tail delta + new response were uploaded.
  expect(newPiecesForTurn2).toBeLessThanOrEqual(4);

  // Reconstruct both captures from ClickHouse pieces and verify exact SHA-256.
  for (const [traceId, expectedReq, expectedRes] of [
    ['trace-cdc-turn-1', turn1Req, turn1Res],
    ['trace-cdc-turn-2', turn2Req, turn2Res],
  ] as const) {
    const rows = [...fake.rows.values()].filter((r) => r.kind === 'capture-chunk' && r.trace_id === traceId);
    expect(rows.every((r) => r.schema_version === CLICKHOUSE_CDC_WIRE_VERSION)).toBe(true);
    for (const [dir, expected] of [['request', expectedReq], ['response', expectedRes]] as const) {
      const dirRows = rows.filter((r) => JSON.parse(r.record_json).direction === dir);
      const rebuilt = Buffer.concat(dirRows.flatMap((r) => r.request_pieces!.map((ref) => {
        const piece = fake.pieces.get(`${r.source_id}:${ref.piece_seq}`)!;
        expect(piece.thread_id).toBe(CDC_PIECE_THREAD);
        return Buffer.from(piece.bytes).subarray(ref.offset, ref.offset + ref.length);
      })));
      expect(rebuilt.equals(expected)).toBe(true);
    }
  }
});

it('coalesces 300 WebSocket frames (including empty frames) into 2 facts with exact frame boundaries', async () => {
  const { archive, exporter } = setup();
  const fake = await startDemoClickHouse();
  servers.push(fake);
  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: fake.endpoint });
  exporter.prepare();

  const req = Buffer.from('{"type":"ws.open"}');
  const res = randomBytes(300 * 128);
  const recs = wireStream('cap-ws', 'trace-cdc-ws-01', 1, req, res, { messages: 300, emptyFrame: true });
  ingest(archive, recs);
  const up = makeUploader(exporter);
  while (await up.runOnce()) { /* drain */ }

  const chunkFacts = [...fake.rows.values()].filter((r) => r.kind === 'capture-chunk' && r.trace_id === 'trace-cdc-ws-01');
  expect(chunkFacts).toHaveLength(2);
  const resFact = chunkFacts.find((r) => JSON.parse(r.record_json).direction === 'response')!;
  const meta = JSON.parse(resFact.record_json) as { representation: string; rawBytes: number; frames: CdcFrameBoundary[] };
  expect(meta.representation).toBe(CLICKHOUSE_CDC_WIRE);
  expect(meta.frames).toHaveLength(300);
  expect(meta.frames[1]!.length).toBe(0);
  expect(meta.frames.every((f) => f.end)).toBe(true);

  const rebuilt = Buffer.concat(resFact.request_pieces!.map((ref) => Buffer.from(fake.pieces.get(`${resFact.source_id}:${ref.piece_seq}`)!.bytes)));
  expect(rebuilt.length).toBe(meta.rawBytes);
  const end = [...fake.rows.values()].find((r) => r.kind === 'capture-end' && r.trace_id === 'trace-cdc-ws-01')!;
  expect(createHash('sha256').update(rebuilt).digest('hex')).toBe(JSON.parse(end.record_json).responseSha256);
});

it('clears the CDC chunk index on destination change and backfills all chunks fresh', async () => {
  const { db, archive, exporter } = setup();
  const first = await startDemoClickHouse();
  const second = await startDemoClickHouse();
  servers.push(first, second);

  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: first.endpoint });
  exporter.prepare();
  const req = randomBytes(32 * 1024), res = randomBytes(16 * 1024);
  ingest(archive, wireStream('cap-dest', 'trace-cdc-dest', 1, req, res));
  const up = makeUploader(exporter);
  while (await up.runOnce()) { /* drain */ }
  expect(first.pieces.size).toBeGreaterThan(0);

  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: second.endpoint });
  expect(db.prepare('SELECT count(*) AS n FROM clickhouse_cdc_chunks').get()).toEqual({ n: 0 });
  while (await up.runOnce()) { /* drain */ }
  expect(second.pieces.size).toBe(first.pieces.size);
  const reqFact = [...second.rows.values()].find((r) => r.kind === 'capture-chunk' && JSON.parse(r.record_json).direction === 'request')!;
  const rebuilt = Buffer.concat(reqFact.request_pieces!.map((ref) => Buffer.from(second.pieces.get(`${reqFact.source_id}:${ref.piece_seq}`)!.bytes)));
  expect(rebuilt.equals(req)).toBe(true);
});

it('emits partial CDC chunks when an open v5 capture is orphaned by a proxy epoch reset', async () => {
  const { archive, exporter } = setup();
  const fake = await startDemoClickHouse();
  servers.push(fake);
  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: fake.endpoint });
  exporter.prepare();

  const req = Buffer.from('partial-request-bytes-before-crash');
  const recs = wireStream('cap-orphan', 'trace-cdc-orphan', 1, req, Buffer.from('never-sent'));
  ingest(archive, recs.slice(0, 2)); // start + request data only, no end
  archive.ingest({ version: 2, epoch: 'next-epoch', dropped: 0, records: [] });

  const up = makeUploader(exporter);
  while (await up.runOnce()) { /* drain */ }
  const chunkFacts = [...fake.rows.values()].filter((r) => r.kind === 'capture-chunk' && r.trace_id === 'trace-cdc-orphan');
  expect(chunkFacts).toHaveLength(1);
  const rebuilt = Buffer.concat(chunkFacts[0]!.request_pieces!.map((ref) => Buffer.from(fake.pieces.get(`${chunkFacts[0]!.source_id}:${ref.piece_seq}`)!.bytes)));
  expect(rebuilt.equals(req)).toBe(true);
});

it('splits a large v5 capture across pieces-only and fact batches within CLICKHOUSE_BATCH_BYTES', () => {
  const { archive, exporter } = setup();
  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: 'http://127.0.0.1:8123' });
  exporter.prepare();
  const huge = randomBytes(CLICKHOUSE_BATCH_BYTES + CAPTURE_CHUNK_BYTES);
  ingest(archive, wireStream('cap-huge', 'trace-cdc-huge', 1, huge, Buffer.from('ok')));
  let batches = 0;
  for (;;) {
    const batch = exporter.prepare();
    if (!batch) break;
    expect(batch.pieces).toBe('');
    expect(Buffer.byteLength(batch.facts) + (batch.rawPieces?.byteLength ?? 0)).toBeLessThanOrEqual(CLICKHOUSE_BATCH_BYTES);
    exporter.acknowledge(batch.token, batch.destination);
    batches++;
  }
  expect(batches).toBeGreaterThan(1);
  expect(exporter.status()).toMatchObject({ queued: 0, discarded: 0 });
});

it('preserves CDC chunks queued before first prepare() on upgrade (S1) and reclaims unsent chunks when includeBodies turns off (S2/S3)', async () => {
  const { db, archive, exporter } = setup();
  const fake = await startDemoClickHouse();
  servers.push(fake);
  // Simulate upgrade: destination already configured in DB, no CDC_DELIVERY_DESTINATION meta yet.
  const cfg = { ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: fake.endpoint };
  db.prepare('UPDATE clickhouse_export SET config=?').run(JSON.stringify(cfg));
  db.prepare("DELETE FROM archive_meta WHERE key='clickhouseCdcDeliveryDestination'").run();

  const req = randomBytes(24 * 1024), res = Buffer.from('upgrade-ok');
  const upgRecs = wireStream('cap-upg', 'trace-cdc-upg', 1, req, res);
  ingest(archive, upgRecs);
  const up = makeUploader(exporter);
  while (await up.runOnce()) { /* drain */ }
  expect(exporter.status()).toMatchObject({ queued: 0, error: null });
  const reqFact = [...fake.rows.values()].find((r) => r.kind === 'capture-chunk' && r.trace_id === 'trace-cdc-upg' && JSON.parse(r.record_json).direction === 'request')!;
  expect(Buffer.concat(reqFact.request_pieces!.map((ref) => Buffer.from(fake.pieces.get(`${reqFact.source_id}:${ref.piece_seq}`)!.bytes))).equals(req)).toBe(true);

  // Queue another capture with includeBodies on, then disable includeBodies before draining.
  ingest(archive, wireStream('cap-meta', 'trace-cdc-meta', upgRecs.length + 1, randomBytes(24 * 1024), Buffer.from('meta-res')));
  expect((db.prepare('SELECT count(*) AS n FROM clickhouse_cdc_chunks WHERE sent=0').get() as { n: number }).n).toBeGreaterThan(0);
  exporter.configure({ ...cfg, includeBodies: false });
  while (await up.runOnce()) { /* drain */ }
  // S2: unsent compressed chunks are reclaimed once no queued outbox row references content.
  expect(db.prepare('SELECT count(*) AS n FROM clickhouse_cdc_chunks WHERE sent=0').get()).toEqual({ n: 0 });
  // S3: metadata-only v5 capture-chunk facts still carry schema_version = 5.
  const metaChunks = [...fake.rows.values()].filter((r) => r.kind === 'capture-chunk' && r.trace_id === 'trace-cdc-meta');
  expect(metaChunks.length).toBeGreaterThan(0);
  expect(metaChunks.every((r) => r.schema_version === CLICKHOUSE_CDC_WIRE_VERSION && r.content_policy === 'metadata-only')).toBe(true);
});

it('achieves ~8 KiB average chunk size with normalized FastCDC (S4) and bounds frames in metadata-only mode (S6)', () => {
  const sample = randomBytes(4 * 1024 * 1024);
  const chunks = chunkBytes(sample);
  const avg = sample.length / chunks.length;
  expect(avg).toBeGreaterThan(6_500);
  expect(avg).toBeLessThan(9_500);

  const { archive, exporter } = setup();
  exporter.configure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: false, endpoint: 'http://127.0.0.1:8123' });
  exporter.prepare();
  ingest(archive, wireStream('cap-ws-meta', 'trace-cdc-ws-meta', 1, Buffer.from('hi'), randomBytes(2_500 * 4), { messages: 2_500 }));
  const facts: { kind: string; schema_version: number; record_json: string }[] = [];
  for (;;) {
    const batch = exporter.prepare();
    if (!batch) break;
    for (const line of batch.facts.trim().split('\n').filter(Boolean)) facts.push(JSON.parse(line));
    exporter.acknowledge(batch.token, batch.destination);
  }
  const resChunks = facts.filter((r) => r.kind === 'capture-chunk' && JSON.parse(r.record_json).direction === 'response');
  expect(resChunks.length).toBeGreaterThan(1);
  expect(resChunks.every((r) => r.schema_version === CLICKHOUSE_CDC_WIRE_VERSION && JSON.parse(r.record_json).frames.length <= 2_048)).toBe(true);
});

it('reconciles CDC binding before backfill after an older-build destination change (S7) and skips wire reads when trace export is off (S9)', () => {
  const { db, archive, exporter } = setup();
  // S9: when trace export is off, finalization creates zero CDC chunks and queues nothing.
  const req = randomBytes(24 * 1024), res = Buffer.from('s7-res');
  ingest(archive, wireStream('cap-s7', 'trace-cdc-s7', 1, req, res));
  expect(db.prepare('SELECT count(*) AS n FROM clickhouse_cdc_chunks').get()).toEqual({ n: 0 });
  expect(exporter.status().queued).toBe(0);

  const first = { ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, includeBodies: true, endpoint: 'http://127.0.0.1:8123' };
  exporter.configure(first);
  for (;;) { const b = exporter.prepare(); if (!b) break; exporter.acknowledge(b.token, b.destination); }
  expect((db.prepare('SELECT count(*) AS n FROM clickhouse_cdc_chunks WHERE sent=1').get() as { n: number }).n).toBeGreaterThan(0);

  // S7: simulate an older build changing destination (resets legacy sent, sets backfill_cursor, leaves clickhouse_cdc_chunks stale).
  const second = { ...first, endpoint: 'http://127.0.0.1:8124' };
  db.exec('DELETE FROM clickhouse_outbox; UPDATE archive_pieces SET sent=0');
  db.prepare('UPDATE clickhouse_export SET config=?, backfill_cursor=?').run(JSON.stringify(second), JSON.stringify(['', '']));
  const b1 = exporter.prepare()!;
  expect(b1.rawPieces?.byteLength).toBeGreaterThan(0);
  exporter.acknowledge(b1.token, b1.destination);
  while (true) { const b = exporter.prepare(); if (!b) break; exporter.acknowledge(b.token, b.destination); }
  expect(exporter.status()).toMatchObject({ queued: 0, error: null });
});
