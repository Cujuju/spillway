import { zstdDecompressSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { archiveCursor, CAPTURE_BODY_LIMIT, DEFAULT_ARCHIVE_POLICY, type CaptureRecord } from '@shared/archive';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
import { migratePieces } from './archivePieces';
import { parseActivityEvent } from './sse';

const dirs: string[] = [], dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-archive-')); dirs.push(dir);
  const file = path.join(dir, 'activity.db');
  const db = openActivityDb(file, 'ab'.repeat(32)); dbs.push(db);
  return { db, store: new ArchiveStore(db), file };
}
function record(sequence = 1, extra: Partial<CaptureRecord> = {}): CaptureRecord {
  return { id: `capture-${sequence}`, traceId: `inbound-full-${sequence}`, epoch: 'epoch-a', sequence, startedAt: new Date().toISOString(), method: 'POST', path: '/v1/responses', status: 200, state: 'complete', reason: '', request: '{"input":"needle private prompt"}', response: 'data: {"output":"response text"}', requestType: 'application/json', responseType: 'text/event-stream', requestEncoding: '', responseEncoding: '', ...extra };
}
function observe(store: ArchiveStore, trace = 'inbound-full-1', request = 'execution-1') {
  store.observe(parseActivityEvent(JSON.stringify({ request_id: request, trace_id: trace, session_id: 'claude:session', provider: 'claude', model: 'opus' }))!);
}
it('defaults to metadata only, keeps unknown identities unknown and never imports client bodies', () => {
  const { store } = setup();
  observe(store);
  expect(store.detail('inbound-full-1')).toMatchObject({ state: 'missing', reason: 'metadata-only', request: '' });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record()] });
  expect(store.query({ text: 'needle' }).entries).toEqual([]);
  store.observe({ ...parseActivityEvent('{"request_id":"local","trace_id":"local-trace"}')!, source: 'client-log' });
  expect(store.detail('local-trace')).toBeNull(); expect(store.detail('unknown-id')).toBeNull();
});
it('persists encrypted bodies and FTS, replays atomically, and links multiple execution IDs by full trace', () => {
  const { store, db, file } = setup();
  store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); observe(store); observe(store, 'inbound-full-1', 'execution-2');
  expect(store.detail('inbound-full-1')?.state).toBe('pending');
  const page = { version: 1, epoch: 'epoch-a', dropped: 0, records: [record()] };
  store.ingest(page); store.ingest(page);
  expect(store.query({ text: 'needle', provider: 'claude', model: 'opus', sessionId: 'claude:session' }).entries).toHaveLength(1);
  expect(store.query({ text: 'needle', provider: 'codex' }).entries).toHaveLength(0);
  expect(store.detail('inbound-full-1')?.attempts).toHaveLength(2);
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  expect(readFileSync(file).includes(Buffer.from('needle private prompt'))).toBe(false);
  const reopened = openActivityDb(file, 'ab'.repeat(32)); dbs.push(reopened);
  const restored = new ArchiveStore(reopened);
  expect(restored.query({ text: 'needle' }).entries[0]?.id).toBe('trace:inbound-full-1');
  expect(restored.detail('inbound-full-1')?.captureId).toBe('capture-1');
});
it('deletes body and FTS on expiry, preserving identities independent of reused Activity row IDs', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record()] });
  db.exec("INSERT INTO requests VALUES(1,'2020-01-01',0,'{}'); DELETE FROM requests; INSERT INTO requests VALUES(1,'2026-11-05',0,'{}');");
  store.prune(Date.now() + 8 * 86_400_000);
  expect(store.detail('inbound-full-1')).toMatchObject({ state: 'expired', request: '', response: '', bytes: 0 });
  expect(store.query({ text: 'needle' }).entries).toHaveLength(0);
});
it('evicts oldest bodies by byte budget, bounds queries and treats keywords as literals', () => {
  const { store } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true, maxBytes: 1024 * 1024 });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 2, records: [1, 2, 3].map((n) => record(n, { request: 'a'.repeat(250_000), response: 'b'.repeat(250_000) })) });
  expect(store.detail('inbound-full-1')?.state).toBe('complete');
  expect(store.status().storedBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(() => store.query({ text: '" OR * NOT (broken' })).not.toThrow();
  expect(store.query({ state: 'complete' }).entries).toHaveLength(3);
});
it('records gaps/restarts and skips malformed records with a trustworthy cursor', () => {
  const { store } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); observe(store);
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 3, records: [record(4)] });
  expect(store.status()).toMatchObject({ sequence: 4, gaps: 3, dropped: 3 });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 3, records: [record(5), record(6, { request: 'x'.repeat(CAPTURE_BODY_LIMIT * 4 + 1) }), record(7)] });
  expect(store.status()).toMatchObject({ sequence: 7, rejected: 1 }); expect(store.detail('inbound-full-6')).toBeNull();
  expect(store.detail('inbound-full-7')?.state).toBe('complete');
  store.ingest({ version: 1, epoch: 'epoch-b', dropped: 0, records: [] });
  expect(store.status()).toMatchObject({ sequence: 0, restarts: 1 });
  expect(store.detail('inbound-full-1')?.reason).toBe('proxy-restarted-before-capture');
});
it('rolls back real database errors without advancing the replay cursor', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  db.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON archive_entries WHEN NEW.trace_id='inbound-full-2' BEGIN SELECT RAISE(ABORT,'disk write failed'); END");
  expect(() => store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(1), record(2)] })).toThrow('disk write failed');
  expect(store.status().sequence).toBe(0); expect(store.detail('inbound-full-1')).toBeNull();
});
it('indexes JSON escapes and joins Claude/Codex stream deltas and WebSocket fragments', () => {
  const { store } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(1, { request: JSON.stringify({ input: 'first\nsecond\tthird' }), response: 'data: {"delta":{"type":"text_delta","text":"arch"}}\n\ndata: {"delta":{"type":"text_delta","text":"ive"}}\n\n' }), record(2, { frames: [{ index: 1, direction: 'response', at: new Date().toISOString(), type: 'text', truncated: false, payload: '{"delta":"web"}' }, { index: 2, direction: 'response', at: new Date().toISOString(), type: 'text', truncated: false, payload: '{"delta":"socket"}' }] })] });
  expect(store.query({ text: 'second third archive' }).entries).toHaveLength(1);
  expect(store.query({ text: 'websocket' }).entries).toHaveLength(1);
});
it('counts only retained non-empty bodies, keeps empty records out of expiry, and resets diagnostic counters', () => {
  const { store } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  expect(store.status()).toMatchObject({ entries: 0, bodies: 0 });
  observe(store, 'metadata-only-trace');
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 4, records: [record(1), record(2, { request: '', response: '' }), record(3, { state: 'missing', request: '', response: '' })] });
  expect(store.status()).toMatchObject({ entries: 4, bodies: 1 });
  store.prune(Date.now() + 10 * 86_400_000);
  expect(store.detail('inbound-full-3')).toMatchObject({ state: 'missing', bytes: 0 });
  expect(store.status()).toMatchObject({ entries: 4, bodies: 0 });
  store.clear(); expect(store.status()).toMatchObject({ entries: 0, bodies: 0, dropped: 0, gaps: 0, restarts: 0, rejected: 0 });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 4, records: [] });
  expect(store.status().dropped).toBe(0);
});
it('pages with a durable tuple cursor even after the last displayed row is removed', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  const at = Date.now();
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(1, { startedAt: new Date(at - 1000).toISOString() }), record(2, { startedAt: new Date(at).toISOString() })] });
  const first = store.query().entries[0]!; db.prepare('DELETE FROM archive_entries WHERE id=?').run(first.id);
  expect(store.query({ before: archiveCursor(first) }).entries[0]?.traceId).toBe('inbound-full-1');
});
it('clears index and bodies and makes timed-out pending states explicit', () => {
  const { store } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); observe(store);
  store.prune(Date.now() + 11 * 60_000);
  expect(store.detail('inbound-full-1')?.state).toBe('missing');
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record()] }); store.clear();
  expect(store.query({ text: 'needle' }).entries).toEqual([]); expect(store.status().entries).toBe(0);
});

it('round trips thread diffs across gaps, revisions, truncation and UTF-8 cut points', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  const requests = ['{"text":"😀alpha海tail"}', '{"text":"😁beta海tail"}', '{"text":"😁beta海', '', '{"text":"new\\nword"}'];
  for (const [i, request] of requests.entries()) {
    observe(store, `diff-trace-${i}`);
    store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(i * 2 + 1, { traceId: `diff-trace-${i}`, request })] });
    expect(store.detail(`diff-trace-${i}`)?.request).toBe(request);
  }
  observe(store, 'diff-trace-0');
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(12, { traceId: 'diff-trace-0', request: 'revision 😀' })] });
  expect(store.detail('diff-trace-0')?.request).toBe('revision 😀');
  expect(store.status()).toMatchObject({ threads: 1, diffFallbacks: 0, gaps: 6 });
  const refs = db.prepare('SELECT detail FROM archive_entries WHERE bytes>0').all() as { detail: string }[];
  for (const r of refs) expect(Array.isArray(JSON.parse(r.detail).request)).toBe(true);
});
it('indexes only new request text and keeps thread ownership fixed after observe changes', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  observe(store); observe(store, 'inbound-full-2');
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(), record(2, { request: '{"input":"needle private prompt plus novelty"}' })] });
  expect(store.query({ text: 'needle' }).entries.map((e) => e.traceId)).toEqual(['inbound-full-1']);
  expect(store.query({ text: 'novelty' }).entries).toHaveLength(1);
  store.observe(parseActivityEvent('{"request_id":"changed","trace_id":"inbound-full-2","session_id":"elsewhere","model":"other"}')!);
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(3, { traceId: 'inbound-full-2', request: 'final' })] });
  expect(store.status().threads).toBe(1);
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='archive_search'").get()).toMatchObject({ sql: expect.stringContaining("contentless_delete=1") });
});
it('migrates existing full details in batches and resumes after its persisted cursor', () => {
  const { db } = setup();
  const body = { request: 'legacy 😀', response: 'reply', requestType: '', responseType: '', requestEncoding: '', responseEncoding: '', format: 'http', requestDecoded: false, responseDecoded: false, frames: [] };
  const at = new Date().toISOString();
  db.prepare("DELETE FROM archive_meta WHERE key='piecesMigrated'").run();
  db.transaction(() => { for (let i = 0; i < 19; i++) db.prepare("INSERT INTO archive_entries(id,trace_id,at,state,reason,session_id,model,bytes,detail) VALUES(?,?,?,'complete','','legacy','model',?,?)").run(`trace:legacy-${i.toString().padStart(2, '0')}`, `legacy-${i.toString().padStart(2, '0')}`, at, Buffer.byteLength(JSON.stringify(body)), JSON.stringify(body)); })();
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql === 'SELECT at,session_id,model,thread_id FROM archive_entries WHERE id=?') {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, 'get').mockImplementation((...args: unknown[]) => {
        if (args[0] === 'trace:legacy-08') throw new Error('migration interrupted');
        return get(...args);
      });
    }
    return statement;
  });
  const progress = vi.fn();
  try { expect(() => new ArchiveStore(db, undefined, progress)).toThrow('migration interrupted'); } finally { spy.mockRestore(); }
  expect(db.prepare("SELECT value FROM archive_meta WHERE key='pieceCursor'").get()).toEqual({ value: JSON.stringify([at, 'trace:legacy-07']) });
  expect(progress.mock.calls.map(([state]) => state)).toEqual([
    { state: 'migrating', done: 0, total: 19 },
    { state: 'migrating', done: 8, total: 19 },
  ]);
  progress.mockClear();
  const migrated = new ArchiveStore(db, undefined, progress);
  expect(progress.mock.calls.map(([state]) => state)).toEqual([
    { state: 'migrating', done: 0, total: 11 },
    { state: 'migrating', done: 8, total: 11 },
    { state: 'migrating', done: 11, total: 11 },
    { state: 'idle', done: 11, total: 11 },
  ]);
  expect(migrated.status()).toMatchObject({ bodies: 19, threads: 1, diffFallbacks: 0 });
  expect(migrated.detail('legacy-18')?.request).toBe(body.request);
  expect(migrated.query({ text: 'legacy' }).entries).toHaveLength(1);
  progress.mockClear();
  expect(new ArchiveStore(db, undefined, progress).status().storedBytes).toBe(migrated.status().storedBytes);
  expect(progress).not.toHaveBeenCalled();
});
it('evicts whole threads and stops an over-budget thread until the policy changes', async () => {
  const { randomBytes } = await import('node:crypto');
  const { store } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true, maxBytes: 1024 * 1024 });
  const noisy = () => randomBytes(350_000).toString('base64');
  observe(store); observe(store, 'inbound-full-2');
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(1, { request: noisy(), response: noisy() }), record(2, { request: noisy(), response: noisy() })] });
  expect(store.detail('inbound-full-1')?.state).toBe('complete');
  expect(store.detail('inbound-full-2')).toMatchObject({ state: 'missing', reason: 'thread-over-budget', bytes: 0 });
  expect(store.status().overBudgetThreads).toBe(1);
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(3, { traceId: 'inbound-full-2', request: 'tiny' })] });
  expect(store.detail('inbound-full-2')?.state).toBe('missing');
  store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true, maxBytes: 2 * 1024 * 1024 });
  expect(store.status().overBudgetThreads).toBe(0);
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(4, { traceId: 'inbound-full-2', request: 'tiny' })] });
  expect(store.detail('inbound-full-2')?.request).toBe('tiny');
  store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true, maxBytes: 1024 * 1024 });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(5, { request: noisy(), response: noisy() })] });
  expect(store.detail('inbound-full-1')?.state).toBe('expired');
  expect(store.detail('inbound-full-2')?.state).toBe('expired');
});
it('falls back to a verified full copy when the proposed ranges rebuild incorrectly', async () => {
  const { zstdCompressSync } = await import('node:zlib');
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  const prepare = db.prepare.bind(db); let corrupt = true;
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql === 'SELECT bytes FROM archive_pieces WHERE id=?' && corrupt) {
      vi.spyOn(statement, 'get').mockImplementation(() => { corrupt = false; return { bytes: zstdCompressSync(Buffer.from('incorrect bytes')) }; });
    }
    return statement;
  });
  try { store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record()] }); } finally { spy.mockRestore(); }
  expect(store.status().diffFallbacks).toBe(1);
  expect(store.detail('inbound-full-1')?.request).toBe(record().request);
});
it('uses a full copy when the thread base cannot be read', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  observe(store); observe(store, 'inbound-full-2');
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record()] });
  db.exec("UPDATE archive_threads SET base='invalid-json'");
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(2, { request: 'replacement 😀' })] });
  expect(store.detail('inbound-full-2')?.request).toBe('replacement 😀');
  expect(store.detail('inbound-full-1')?.request).toBe(record().request);
  expect(store.status().diffFallbacks).toBe(0);
});
it('keeps thread totals exact after bodyless revisions and metadata pruning', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  observe(store);
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record()] });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(2, { traceId: 'inbound-full-1', request: '', response: '' })] });
  const pieces = (db.prepare('SELECT sum(length(bytes)) AS n FROM archive_pieces').get() as { n: number }).n;
  expect(store.status().storedBytes).toBe(pieces);
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(3, { traceId: 'inbound-full-1' })] });
  const allPieces = (db.prepare('SELECT sum(length(bytes)) AS n FROM archive_pieces').get() as { n: number }).n;
  const at = new Date(Date.now() + 1000).toISOString();
  db.transaction(() => {
    const insert = db.prepare("INSERT INTO archive_entries(id,trace_id,at,state,reason) VALUES(?,?,?,'missing','metadata-only')");
    for (let i = 0; i < 20_000; i++) insert.run(`metadata-${i}`, `metadata-${i}`, at);
  })();
  store.prune(Date.now(), true);
  expect(store.status()).toMatchObject({ entries: 20_000, bytes: 0, storedBytes: allPieces });
});

it('does not report migration progress for an empty archive', () => {
  const { db } = setup();
  db.prepare("DELETE FROM archive_meta WHERE key='piecesMigrated'").run();
  const progress = vi.fn();
  migratePieces(db, progress);
  expect(progress).not.toHaveBeenCalled();
});

it('validates per-side cuts and preserves complete versus legacy metadata', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(1, { request: 'headtail', requestCut: { offset: 4, omitted: 20 }, responseCut: null }), record(2, { request: 'headtail', requestCut: { offset: 9, omitted: null } }), record(3, { requestCut: { offset: 1, omitted: -1 } })] });
  expect(store.status().rejected).toBe(2);
  expect(store.detail('inbound-full-1')).toMatchObject({ request: 'headtail', requestCut: { offset: 4, omitted: 20 }, responseCut: null });
  db.prepare("UPDATE archive_entries SET detail=json_remove(detail,'$.requestCut','$.responseCut') WHERE trace_id=?").run('inbound-full-1');
  expect(store.detail('inbound-full-1')?.requestCut).toBeUndefined();
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(4, { requestCut: { offset: 0, omitted: null } })] });
  expect(store.detail('inbound-full-4')?.requestCut).toEqual({ offset: 0, omitted: null });
  // An older proxy sends no cut fields: they stay absent, so the inspector applies the legacy start-only test.
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(5, { request: 'old proxy' })] });
  expect(store.detail('inbound-full-5')).toMatchObject({ request: 'old proxy' });
  expect(store.detail('inbound-full-5')).not.toHaveProperty('requestCut');
  expect(store.detail('inbound-full-5')).not.toHaveProperty('responseCut');
});
it('diffs frame snapshots across websocket revisions with bounded growth', () => {
  const { store, db } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  const frames: NonNullable<CaptureRecord['frames']> = [];
  for (let n = 1; n <= 20; n++) {
    frames.push({ index: n, direction: 'response', at: new Date().toISOString(), type: 'text', truncated: false, payload: Array.from({ length: 200 }, (_, i) => `${n}:${i}`).join(',') });
    store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record(n, { traceId: 'websocket-revisions', format: 'websocket', request: '', response: frames.map((f) => f.payload).join('\n'), frames: [...frames] })] });
    expect(store.detail('websocket-revisions')?.frames).toEqual(frames);
  }
  const logical = Buffer.byteLength(JSON.stringify(frames));
  const pieces = db.prepare('SELECT bytes FROM archive_pieces').all() as { bytes: Buffer }[];
  expect(pieces.reduce((n, p) => n + zstdDecompressSync(p.bytes).length, 0)).toBeLessThan(logical * 3);
  expect(store.status().diffFallbacks).toBe(0);
});
