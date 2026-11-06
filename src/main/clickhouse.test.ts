import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY, type CaptureRecord } from '@shared/archive';
import { CLICKHOUSE_BATCH_BYTES, CLICKHOUSE_BATCH_ROWS, CLICKHOUSE_QUEUE_LIMIT, DEFAULT_CLICKHOUSE_CONFIG, validateClickHouseConfig, validateClickHouseCredentials } from '@shared/clickhouse';
import { startDemoClickHouse } from '../../scripts/demo/clickhouse.mts';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
import { ClickHouseStore } from './clickhouseStore';
import { ClickHouseUploader } from './clickhouseUploader';
import { checkClickHouseSchema, clickhouseRequest, clickhouseTimeout, insertClickHouse } from './clickhouseHttp';
import { parseActivityEvent } from './sse';

const dirs: string[] = [], dbs: Db[] = [], servers: Awaited<ReturnType<typeof startDemoClickHouse>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await server.close(); for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-clickhouse-')); dirs.push(dir);
  const file = path.join(dir, 'activity.db'), db = openActivityDb(file, 'ab'.repeat(32)); dbs.push(db);
  const archive = new ArchiveStore(db), store = new ClickHouseStore(db, archive);
  return { db, archive, store, file };
}
function record(sequence = 1, extra: Partial<CaptureRecord> = {}): CaptureRecord {
  return { id: 'capture-one', traceId: 'full-trace-0001', epoch: 'epoch-a', sequence, startedAt: new Date().toISOString(), method: 'POST', path: '/v1/responses', status: 200, state: 'complete', reason: '', request: 'private-content-for-upload', response: 'model text', requestType: 'application/json', responseType: 'text/event-stream', requestEncoding: '', responseEncoding: '', ...extra };
}
function observe(archive: ArchiveStore, trace = 'full-trace-0001') {
  archive.observe(parseActivityEvent(JSON.stringify({ request_id: `execution-${trace}`, trace_id: trace, session_id: 'session-a', model: 'alias', provider: 'codex' }))!);
}
function ingest(archive: ArchiveStore, r = record()) { archive.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [r] }); }
const config = { ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, endpoint: 'http://127.0.0.1:8123' };
const lines = (payload: string) => payload.trim().split('\n').map((s) => JSON.parse(s) as { source_id: string; id: string; revision: number; capture_state: string; content_policy: string; record_json: string });
async function server() { const s = await startDemoClickHouse(); servers.push(s); return s; }
function uploader(store: ClickHouseStore) {
  return new ClickHouseUploader({ status: async () => store.status(), prepare: async () => store.prepare(), acknowledge: async (t, d) => store.acknowledge(t, d), fail: async (t, n, e) => store.fail(t, n, e) }, () => ({ username: 'test-user', password: 'test-secret' }));
}

it('validates origins, identifiers and credentials without reflecting sensitive input', () => {
  expect(validateClickHouseConfig(DEFAULT_CLICKHOUSE_CONFIG)).toEqual(DEFAULT_CLICKHOUSE_CONFIG);
  for (const endpoint of ['file:///tmp/x', 'http://user:secret@host', 'http://host/?password=secret', 'http://host/path', 'http://host/#secret']) expect(() => validateClickHouseConfig({ ...config, endpoint })).toThrow(/HTTP\(S\) origin/);
  for (const table of ['x; DROP TABLE y', 'x.y', '`x`', 'a'.repeat(64)]) expect(() => validateClickHouseConfig({ ...config, table })).toThrow(/identifiers/);
  expect(() => validateClickHouseCredentials({ username: 'x\nsecret', password: 'password' })).toThrow('Invalid ClickHouse credentials');
  expect(() => validateClickHouseCredentials({ username: '账户', password: 'password' })).toThrow(/Latin-1/);
});
it('defaults off, backfills metadata only, and ignores imported client-log prompts', () => {
  const { archive, store } = setup(); observe(archive);
  archive.observe({ ...parseActivityEvent('{"request_id":"local","trace_id":"local-trace"}')!, source: 'client-log' });
  expect(store.status().queued).toBe(0); expect(store.prepare()).toBeNull();
  store.configure(config); const b = store.prepare()!;
  expect(b.rows).toHaveLength(1); expect(lines(b.payload)[0]).toMatchObject({ id: 'trace:full-trace-0001', capture_state: 'missing', content_policy: 'metadata-only' });
  expect(JSON.parse(lines(b.payload)[0]!.record_json)).not.toHaveProperty('request');
});
it('requires both body opt-ins and creates newer versions for policy changes', () => {
  const { archive, store } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); ingest(archive);
  store.configure(config); const metadata = store.prepare()!; expect(metadata.payload).not.toContain('private-content-for-upload'); store.acknowledge(metadata.token, metadata.destination);
  store.configure({ ...config, includeBodies: true }); const content = store.prepare()!;
  expect(content.payload).toContain('private-content-for-upload'); expect(content.rows[0]!.revision).toBeGreaterThan(metadata.rows[0]!.revision);
  archive.setPolicy(DEFAULT_ARCHIVE_POLICY); const disabled = store.prepare()!;
  expect(disabled.payload).not.toContain('private-content-for-upload'); expect(disabled.rows[0]!.revision).toBeGreaterThan(content.rows[0]!.revision);
  expect(lines(disabled.payload)[0]?.content_policy).toBe('source-unavailable');
});
it('acknowledging an old pending WS snapshot leaves its final revision queued; replay is a no-op', () => {
  const { archive, store } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); store.configure({ ...config, includeBodies: true });
  const pending = record(1, { state: 'pending', reason: 'websocket-open', format: 'websocket' }); ingest(archive, pending);
  const first = store.prepare()!; ingest(archive, record(2, { format: 'websocket', response: 'final response' }));
  expect(store.prepare()?.token).toBe(first.token); store.acknowledge(first.token, first.destination);
  const final = store.prepare()!; expect(final.rows[0]!.revision).toBeGreaterThan(first.rows[0]!.revision); expect(lines(final.payload)[0]?.capture_state).toBe('complete');
  store.acknowledge(first.token, first.destination); expect(store.prepare()?.token).toBe(final.token);
  store.acknowledge(final.token, final.destination); ingest(archive, record(2)); expect(store.status().queued).toBe(0);
});
it('keeps frozen payloads, identity and retry/backoff across encrypted database restart', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const { db, archive, store, file } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); ingest(archive); store.configure({ ...config, includeBodies: true });
  const first = store.prepare()!; store.fail(first.token, 1000, 'ClickHouse HTTP 500'); db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  expect(readFileSync(file).includes(Buffer.from('private-content-for-upload'))).toBe(false);
  const reopened = openActivityDb(file, 'ab'.repeat(32)); dbs.push(reopened); const restored = new ClickHouseStore(reopened, new ArchiveStore(reopened));
  expect(restored.prepare()).toMatchObject({ token: first.token, payload: first.payload, attempts: 1, nextAttemptAt: 2000 });
  for (let n = 0; n < 20; n++) restored.fail(first.token, 1000, 'unavailable'); expect(restored.status().nextAttemptAt).toBe(301000);
});
it('expires queued content without pinning it, drops cleared sources, and pauses on disable', () => {
  const { archive, store } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); store.configure({ ...config, includeBodies: true }); ingest(archive);
  const first = store.prepare()!; archive.prune(Date.now() + 8 * 86_400_000);
  expect(store.prepare()?.payload).not.toContain('private-content-for-upload'); expect(lines(store.prepare()!.payload)[0]?.capture_state).toBe('expired');
  store.configure({ ...config, enabled: false, includeBodies: true }); expect(store.prepare()).toBeNull(); expect(store.status().queued).toBe(1);
  observe(archive, 'new-while-disabled'); expect(store.status().queued).toBe(1);
  archive.clear(); expect(store.status().queued).toBe(0); expect(store.batch()).toBeNull(); store.acknowledge(first.token, first.destination); expect(store.status().acknowledged).toBe(0);
});
it('bounds batches and references, refuses destination changes with backlog, and clears explicitly', () => {
  const { db, archive, store } = setup(); store.configure(config);
  db.transaction(() => { for (let n = 0; n < CLICKHOUSE_QUEUE_LIMIT + 2; n++) db.prepare("INSERT INTO archive_entries(id,trace_id,at,state,reason) VALUES(?,?,?,'missing','metadata-only')").run(`trace:full-trace-${n}`, `full-trace-${n}`, new Date().toISOString()); })();
  expect(store.status()).toMatchObject({ queued: CLICKHOUSE_QUEUE_LIMIT, discarded: 2 });
  const batch = store.prepare()!; expect(batch.rows).toHaveLength(CLICKHOUSE_BATCH_ROWS); expect(Buffer.byteLength(batch.payload)).toBeLessThanOrEqual(CLICKHOUSE_BATCH_BYTES);
  expect(() => store.configure({ ...config, table: 'other' })).toThrow(/Clear/);
  store.clear(); expect(store.status().queued).toBe(0); expect(store.prepare()).toBeNull();
  store.configure({ ...config, table: 'other' }); expect(store.status().config.table).toBe('other');
  store.clear();
  observe(archive, 'new-after-clear'); expect(store.status().queued).toBe(1);
}, 20_000);
it('uploads acknowledged batches with header-only credentials and no content/credential diagnostic echo', async () => {
  const s = await server(), { archive, store } = setup(); store.configure({ ...config, endpoint: s.endpoint }); observe(archive);
  await uploader(store).runOnce(); expect(store.status()).toMatchObject({ queued: 0, acknowledged: 1, error: null });
  expect(s.rows.size).toBe(1); const insert = s.requests.find((r) => r.sql.startsWith('INSERT'))!;
  expect(insert.url).toBe('/?wait_end_of_query=1'); expect(insert.key).toBe('test-secret'); expect(insert.sql).toContain('SETTINGS async_insert=1, wait_for_async_insert=1'); expect(insert.sql).not.toContain('test-secret');
  s.behavior.status = 401; s.behavior.body = 'test-secret private-content-for-upload';
  await expect(clickhouseRequest({ ...config, endpoint: s.endpoint }, undefined, 'SELECT 1', new AbortController().signal)).rejects.toThrow('ClickHouse HTTP 401 (credentials or permissions)');
});
it('retains a whole uncertain partial batch, retries identical bytes and logically deduplicates recovery', async () => {
  const s = await server(), { archive, store } = setup(); store.configure({ ...config, endpoint: s.endpoint }); observe(archive); observe(archive, 'full-trace-0002');
  s.behavior.partialRows = 1; s.behavior.insertStatus = 500; s.behavior.insertBody = 'private echoed failure';
  const upload = uploader(store); await upload.runOnce(); expect(s.rows.size).toBe(1); expect(store.status()).toMatchObject({ queued: 2, attempts: 1 });
  await upload.runOnce(); expect(s.requests.filter((r) => r.sql.startsWith('INSERT'))).toHaveLength(1);
  s.behavior.partialRows = -1; s.behavior.insertStatus = 200; s.behavior.insertBody = ''; store.retry(); await upload.runOnce();
  const inserts = s.requests.filter((r) => r.sql.startsWith('INSERT')); expect(inserts).toHaveLength(2); expect(inserts[0]?.sql).toBe(inserts[1]?.sql); expect(s.rows.size).toBe(2); expect(store.status().queued).toBe(0);
});
it('detects HTTP 200 query errors and incompatible schemas without acknowledging data', async () => {
  const s = await server(), { archive, store } = setup(); const c = { ...config, endpoint: s.endpoint }; store.configure(c); observe(archive);
  s.behavior.schema = false; await uploader(store).runOnce(); expect(store.status().queued).toBe(1); expect(store.status().error).toContain('schema v1'); expect(s.requests.some((r) => r.sql.startsWith('INSERT'))).toBe(false);
  s.behavior.schema = true; s.behavior.insertBody = 'Code: 123 secret response';
  await expect(insertClickHouse(c, undefined, '{"source_id":"s","id":"i","revision":1}\n', new AbortController().signal)).rejects.toThrow(/unexpected response/);
  s.behavior.body = '<html>login page</html>'; await expect(checkClickHouseSchema(c, undefined, new AbortController().signal)).rejects.toThrow(/unexpected response/);
});
it('cancels safely while a connection is waiting, preserving durable work', async () => {
  const s = await server(), { archive, store } = setup(); store.configure({ ...config, endpoint: s.endpoint }); observe(archive); s.behavior.delayMs = 1000;
  const upload = uploader(store), running = upload.runOnce();
  // Let the diagnostic reach the fake listener before requesting cancellation.
  await new Promise<void>((resolve) => setTimeout(resolve, 30)); await upload.stop(); await running;
  expect(store.status()).toMatchObject({ queued: 1, acknowledged: 0 }); expect(upload.running).toBe(false); expect(s.rows.size).toBe(0);
});
it('retries disconnected writes and survives an unreachable NAS endpoint without losing backlog', async () => {
  const s = await server(), { archive, store } = setup(); store.configure({ ...config, endpoint: s.endpoint }); observe(archive); s.behavior.insertDisconnect = true;
  const upload = uploader(store); await upload.runOnce(); expect(store.status().queued).toBe(1); expect(s.rows.size).toBe(1);
  s.behavior.insertDisconnect = false; store.retry(); await upload.runOnce(); expect(s.rows.size).toBe(1); expect(store.status().queued).toBe(0);
  const unreachable = await startDemoClickHouse(); const endpoint = unreachable.endpoint; await unreachable.close();
  store.configure({ ...config, endpoint }); observe(archive, 'full-trace-offline'); await upload.runOnce(); expect(store.status().queued).toBeGreaterThan(0); expect(store.status().error).toContain('connection failed');
});
it('binds frozen batches and acknowledgments to destination and never acks replacement backlog', () => {
  const { archive, store } = setup(); observe(archive); store.configure(config); const old = store.prepare()!;
  store.acknowledge(old.token, 'wrong-destination'); expect(store.status().queued).toBe(1);
  store.clear(); store.configure({ ...config, table: 'new_target' }); const next = store.prepare()!;
  expect(next.destination).not.toBe(old.destination); expect(next.token).not.toBe(old.token);
  store.acknowledge(old.token, old.destination); expect(store.prepare()?.token).toBe(next.token); expect(store.status().queued).toBe(1);
  store.acknowledge(next.token, next.destination); expect(store.status().queued).toBe(0);
});
it('preserves peer attempt provenance and skips an oversized poison row without stalling others', () => {
  const { archive, store, db } = setup(); observe(archive); observe(archive, 'full-trace-next');
  db.prepare('UPDATE archive_attempts SET detail=? WHERE trace_id=?').run(JSON.stringify({ requestId: 'execution-id', selectionId: null, at: new Date().toISOString(), provenance: { latencyMs: 123, effectiveModel: null } }), 'full-trace-next');
  db.prepare('UPDATE archive_entries SET model=? WHERE trace_id=?').run('x'.repeat(CLICKHOUSE_BATCH_BYTES), 'full-trace-0001');
  store.configure(config); const batch = store.prepare()!;
  expect(batch.rows).toHaveLength(1); expect(batch.payload).toContain('latencyMs'); expect(batch.payload).toContain('effectiveModel');
  expect(store.status()).toMatchObject({ discarded: 1, oversized: 1 });
  store.acknowledge(batch.token, batch.destination); expect(store.status().queued).toBe(0);
});
it('marks oversized content metadata fallback explicitly and keeps source state', () => {
  const { archive, store, db } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); ingest(archive);
  db.prepare('UPDATE archive_entries SET detail=? WHERE trace_id=?').run(JSON.stringify({ request: 'x'.repeat(CLICKHOUSE_BATCH_BYTES + 1) }), 'full-trace-0001');
  store.configure({ ...config, includeBodies: true }); const b = store.prepare()!;
  expect(lines(b.payload)[0]).toMatchObject({ capture_state: 'complete', content_policy: 'omitted-size-limit' });
  expect(Buffer.byteLength(b.payload)).toBeLessThan(CLICKHOUSE_BATCH_BYTES); expect(store.status().oversized).toBe(0);
});
it('does not acknowledge until the complete successful response arrives', async () => {
  const s = await server(), { archive, store } = setup(); store.configure({ ...config, endpoint: s.endpoint }); observe(archive); s.behavior.insertDelayMs = 80;
  const received = once(s.events, 'insert'); const running = uploader(store).runOnce(); await received;
  expect(store.status()).toMatchObject({ queued: 1, acknowledged: 0 });
  await running; expect(store.status()).toMatchObject({ queued: 0, acknowledged: 1 });
});
it('cancels an RPC wait without waiting for an unavailable Activity worker', async () => {
  const upload = new ClickHouseUploader({ status: () => new Promise(() => {}), prepare: async () => null, acknowledge: async () => {}, fail: async () => {} }, () => undefined);
  const running = upload.runOnce(); await upload.stop(); await running; expect(upload.running).toBe(false);
});
it('retention-only and identical policy saves neither invalidate batches nor re-upload acknowledged rows', () => {
  const { archive, store } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); ingest(archive); store.configure({ ...config, includeBodies: true });
  const b = store.prepare()!; archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); expect(store.prepare()?.token).toBe(b.token);
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true, retentionDays: 8 }); expect(store.prepare()?.token).toBe(b.token);
  store.acknowledge(b.token, b.destination); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true, retentionDays: 9 }); expect(store.status().queued).toBe(0);
});
it('does no exporter state writes on disabled observations, even with retained backlog', () => {
  const { archive, store, db } = setup(); observe(archive); store.configure(config); store.configure({ ...config, enabled: false });
  db.exec('CREATE TABLE test_export_writes(n INTEGER); CREATE TRIGGER test_export_state AFTER UPDATE ON clickhouse_state BEGIN INSERT INTO test_export_writes VALUES(1); END;');
  observe(archive, 'full-trace-offline');
  expect(db.prepare('SELECT count(*) AS n FROM test_export_writes').get()).toEqual({ n: 0 }); expect(store.status().queued).toBe(1);
});
it('refreshes trigger definitions on reopen while preserving durable queued data', () => {
  const { db, archive, store, file } = setup(); observe(archive); store.configure(config); store.configure({ ...config, enabled: false });
  db.exec('DROP TRIGGER clickhouse_insert; CREATE TRIGGER clickhouse_insert AFTER INSERT ON archive_entries BEGIN UPDATE clickhouse_state SET discarded=999; END;'); db.close();
  const reopened = openActivityDb(file, 'ab'.repeat(32)); dbs.push(reopened); const restoredArchive = new ArchiveStore(reopened), restored = new ClickHouseStore(reopened, restoredArchive);
  observe(restoredArchive, 'full-trace-reopened'); expect(restored.status()).toMatchObject({ queued: 1, discarded: 0 });
});
it('accepts versioned plain/shared/replicated engines and rejects other version parameters', async () => {
  const s = await server(), c = { ...config, endpoint: s.endpoint }, signal = new AbortController().signal;
  for (const engine of ['ReplacingMergeTree(revision)', "SharedReplacingMergeTree('/path/with,comma', 'replica', revision) ORDER BY (source_id, id)", "ReplicatedReplacingMergeTree('/path', '{replica}', `revision`) ORDER BY (source_id, id)"]) {
    s.behavior.engine = engine; await expect(checkClickHouseSchema(c, undefined, signal)).resolves.toBeUndefined();
  }
  for (const engine of ['ReplacingMergeTree()', 'ReplacingMergeTree(other_version)', "SharedReplacingMergeTree('/path','replica',revision,is_deleted)"]) {
    s.behavior.engine = engine; await expect(checkClickHouseSchema(c, undefined, signal)).rejects.toThrow(/schema v1/);
  }
  expect(clickhouseTimeout(CLICKHOUSE_BATCH_BYTES)).toBeGreaterThan(2 * 60_000);
});
it('drains a backlog larger than one batch without an interval between acknowledgments', async () => {
  const s = await server(), { db, store } = setup(); store.configure({ ...config, endpoint: s.endpoint });
  db.transaction(() => { for (let n = 0; n <= CLICKHOUSE_BATCH_ROWS; n++) db.prepare("INSERT INTO archive_entries(id,trace_id,at,state,reason) VALUES(?,?,?,'missing','metadata-only')").run(`trace:full-trace-drain-${n}`, `full-trace-drain-${n}`, new Date().toISOString()); })();
  const upload = uploader(store), timer = vi.spyOn(upload as unknown as { schedule(ms: number): void }, 'schedule');
  try {
    upload.start();
    await vi.waitFor(() => expect(store.status().acknowledged).toBe(CLICKHOUSE_BATCH_ROWS + 1), { timeout: 2000 });
    expect(s.requests.filter((r) => r.sql.startsWith('INSERT')).map((r) => lines(r.sql.slice(r.sql.indexOf('\n') + 1)).length)).toEqual([CLICKHOUSE_BATCH_ROWS, 1]);
    expect(timer.mock.calls.slice(0, 2)).toEqual([[0], [0]]);
  } finally { await upload.stop(); }
});
it('verifies schema once across batches and verifies again after an insert failure', async () => {
  const s = await server(), { archive, store } = setup(); store.configure({ ...config, endpoint: s.endpoint });
  const upload = uploader(store), checks = () => s.requests.filter((r) => !r.sql.startsWith('INSERT')).length;
  observe(archive); expect(await upload.runOnce()).toBe(true);
  observe(archive, 'schema-next'); expect(await upload.runOnce()).toBe(true); expect(checks()).toBe(3);
  observe(archive, 'schema-failure'); s.behavior.insertStatus = 500;
  expect(await upload.runOnce()).toBe(false); expect(checks()).toBe(3);
  s.behavior.insertStatus = 200; store.retry();
  expect(await upload.runOnce()).toBe(true); expect(checks()).toBe(6);
  expect(await upload.runOnce()).toBe(false); expect(checks()).toBe(6);
});
it('requests server batching and waits for the asynchronous insert to flush', async () => {
  const s = await server();
  await insertClickHouse({ ...config, endpoint: s.endpoint }, undefined, '{"source_id":"s","id":"i","revision":1}\n', new AbortController().signal);
  expect(s.requests[0]?.sql).toContain('SETTINGS async_insert=1, wait_for_async_insert=1 FORMAT JSONEachRow');
  expect(s.requests[0]?.url).toBe('/?wait_end_of_query=1');
});
it('jitters exponential backoff between half and all of its capped delay', () => {
  const { archive, store } = setup(); observe(archive); store.configure(config); const batch = store.prepare()!;
  const random = vi.spyOn(Math, 'random');
  for (let attempt = 0; attempt < 12; attempt++) {
    const delay = Math.min(300_000, 1000 * 2 ** Math.min(attempt, 9)), value = [0, 0.5, 1][attempt % 3]!;
    random.mockReturnValue(value); store.fail(batch.token, 1000, 'unavailable');
    const actual = store.status().nextAttemptAt - 1000;
    expect(actual).toBeGreaterThanOrEqual(delay / 2); expect(actual).toBeLessThanOrEqual(delay);
    expect(actual).toBe(delay * (1 - 0.5 * value));
  }
});
