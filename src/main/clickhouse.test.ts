import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CAPTURE_BODY_LIMIT, DEFAULT_ARCHIVE_POLICY, type CaptureRecord } from '@shared/archive';
import { CLICKHOUSE_BATCH_BYTES, CLICKHOUSE_BATCH_ROWS, CLICKHOUSE_OUTBOX_BYTES, CLICKHOUSE_SOURCE_LABEL_MAX, CLICKHOUSE_TABLES_MISSING, DEFAULT_CLICKHOUSE_CONFIG, validateClickHouseConfig, validateClickHouseCredentials } from '@shared/clickhouse';
import { startDemoClickHouse } from '../../scripts/demo/clickhouse.mts';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore, type ArchiveFact } from './archiveStore';
import { ClickHouseStore } from './clickhouseStore';
import { encodeClickHouseLine, type OutboxRow } from './clickhouseLine';
import { ActivityLog } from './activityStore';
import { ClickHouseUploader } from './clickhouseUploader';
import { checkClickHouseSchema, clickhouseRequest, clickhouseTimeout, insertClickHouse, sameClickHouseType } from './clickhouseHttp';
import { parseActivityEvent } from './sse';

const dirs: string[] = [], dbs: Db[] = [], servers: Awaited<ReturnType<typeof startDemoClickHouse>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await server.close(); for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-clickhouse-')); dirs.push(dir);
  const file = path.join(dir, 'activity.db'), db = openActivityDb(file, 'ab'.repeat(32)); dbs.push(db);
  let store: ClickHouseStore;
  const archive = new ArchiveStore(db, { append: (f) => store.append(f) }); store = new ClickHouseStore(db, archive);
  return { db, archive, store, file, dir };
}
function record(sequence = 1, extra: Partial<CaptureRecord> = {}): CaptureRecord {
  return { id: 'capture-one', traceId: 'full-trace-0001', epoch: 'epoch-a', sequence, startedAt: new Date().toISOString(), method: 'POST', path: '/v1/responses', status: 200, state: 'complete', reason: '', request: 'private-content-for-upload', response: 'model text', requestType: 'application/json', responseType: 'text/event-stream', requestEncoding: '', responseEncoding: '', ...extra };
}
function observe(archive: ArchiveStore, trace = 'full-trace-0001') { archive.observe(parseActivityEvent(JSON.stringify({ request_id: `execution-${trace}`, trace_id: trace, session_id: 'session-a', model: 'alias', provider: 'codex' }))!); }
function ingest(archive: ArchiveStore, r = record()) { archive.ingest({ version: 1, epoch: r.epoch, dropped: 0, records: [r] }); }
const config = { ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, endpoint: 'http://127.0.0.1:8123' };
const lines = (facts: string) => facts.trim().split('\n').map((s) => JSON.parse(s));
const fact = (n = 0): ArchiveFact => ({ kind: 'attempt', traceId: `trace-${n}`, at: new Date().toISOString(), captureState: '', record: { n }, content: null });
function enable(store: ClickHouseStore) { store.configure(config); store.prepare(); }
async function server() { const s = await startDemoClickHouse(); servers.push(s); return s; }
function uploader(store: ClickHouseStore) { return new ClickHouseUploader({ status: async () => store.status(), prepare: async () => store.prepare(), acknowledge: async (t, d) => store.acknowledge(t, d), fail: async (t, n, e) => store.fail(t, n, e) }, () => ({ username: 'test-user', password: 'test-secret' })); }

it('validates config and source labels including stored v1-shaped configs', () => {
  expect(validateClickHouseConfig(DEFAULT_CLICKHOUSE_CONFIG)).toEqual(DEFAULT_CLICKHOUSE_CONFIG);
  const { sourceLabel: _, ...old } = config; expect(validateClickHouseConfig(old).sourceLabel).toBe('');
  expect(validateClickHouseConfig({ ...config, sourceLabel: ' desktop ' }).sourceLabel).toBe('desktop');
  for (const sourceLabel of ['x'.repeat(65), 'x\ny', '\u0085']) expect(() => validateClickHouseConfig({ ...config, sourceLabel })).toThrow(/label/);
  for (const endpoint of ['file:///tmp/x', 'http://user:secret@host', 'http://host/path']) expect(() => validateClickHouseConfig({ ...config, endpoint })).toThrow(/HTTP\(S\) origin/);
  expect(() => validateClickHouseCredentials({ username: 'x\nsecret', password: 'password' })).toThrow();
});
it('emits immutable facts transactionally, only while enabled and once per accepted input', () => {
  const { db, archive, store } = setup(); observe(archive); expect(store.status().queued).toBe(0);
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); enable(store); store.clear();
  const event = parseActivityEvent('{"request_id":"transaction","trace_id":"transaction-trace"}')!;
  expect(() => db.transaction(() => { archive.observe(event); ingest(archive); throw new Error('rollback'); })()).toThrow();
  expect(store.status().queued).toBe(0); expect(archive.detail('transaction-trace')).toBeNull();
  archive.observe(event); archive.observe(event); ingest(archive); ingest(archive);
  expect(lines(store.prepare()!.facts).map((r) => r.kind)).toEqual(['attempt', 'capture']);
  store.configure({ ...config, enabled: false }); observe(archive, 'disabled-trace'); ingest(archive, record(2)); expect(store.status().queued).toBe(2);
});
it('keeps outbox facts when archive retention and the 20,000 metadata cap prune identities', () => {
  const { db, archive, store } = setup(); enable(store); observe(archive);
  db.transaction(() => { for (let n = 0; n < 20_001; n++) db.prepare("INSERT INTO archive_entries(id,trace_id,at,state,reason) VALUES(?,?,?,'missing','')").run(`trace:bulk-${n}`, `bulk-${n}`, new Date(Date.now() + n + 1).toISOString()); })();
  archive.prune(Date.now(), true); expect(archive.detail('full-trace-0001')).toBeNull(); expect(store.status().queued).toBe(1);
  expect(lines(store.prepare()!.facts)[0].trace_id).toBe('full-trace-0001');
});
it('bounds bytes by dropping oldest rows and counts oversized metadata and invalid dates', () => {
  const { db, store } = setup(); enable(store); store.append(fact());
  db.prepare('UPDATE clickhouse_outbox SET bytes=?').run(CLICKHOUSE_OUTBOX_BYTES);
  db.prepare('UPDATE clickhouse_export SET queued_bytes=?').run(CLICKHOUSE_OUTBOX_BYTES);
  store.append(fact(1)); expect(store.status()).toMatchObject({ queued: 1, discarded: 1 });
  store.append({ ...fact(), record: { huge: 'x'.repeat(CLICKHOUSE_BATCH_BYTES) } }); store.append({ ...fact(), at: 'invalid' });
  expect(store.status()).toMatchObject({ queued: 1, discarded: 3, oversized: 1 });
});
it('discards metadata made oversized by a new label and prepares the next row', () => {
  const { store } = setup(); enable(store);
  const oversized = { ...fact(), record: { huge: '' } };
  const overhead = Buffer.byteLength(encodeClickHouseLine({ seq: Number.MAX_SAFE_INTEGER, kind: oversized.kind, trace_id: oversized.traceId, at: oversized.at, capture_state: oversized.captureState, record: JSON.stringify(oversized.record), content: null }, config, '0'.repeat(32), false));
  oversized.record.huge = 'x'.repeat(CLICKHOUSE_BATCH_BYTES - overhead);
  store.append(oversized); store.append(fact(1));
  expect(store.status()).toMatchObject({ queued: 2, discarded: 0, oversized: 0 });
  store.configure({ ...config, sourceLabel: 'x'.repeat(CLICKHOUSE_SOURCE_LABEL_MAX) });
  const batch = store.prepare();
  expect(batch).not.toBeNull(); expect(batch!.rows).toBe(1);
  expect(lines(batch!.facts)[0].trace_id).toBe('trace-1');
  expect(store.status()).toMatchObject({ queued: 1, discarded: 1, oversized: 1 });
  store.acknowledge(batch!.token, batch!.destination);
  expect(store.prepare()).toBeNull();
  expect(store.status()).toMatchObject({ queued: 0, acknowledged: 1, discarded: 1, oversized: 1 });
});
it('retries identical bytes, preserves new rows during upload, and binds acknowledgments to destination', () => {
  const { store } = setup(); enable(store); store.append(fact()); const b = store.prepare()!;
  store.fail(b.token, Date.now(), 'offline'); expect(store.prepare()).toBeNull(); store.retry(); expect(store.prepare()!.facts).toBe(b.facts);
  store.append(fact(1)); store.acknowledge(b.token, 'wrong'); expect(store.status().queued).toBe(2);
  expect(() => store.configure({ ...config, tablePrefix: 'other' })).toThrow(/Clear/);
  store.acknowledge(b.token, b.destination); expect(store.status()).toMatchObject({ queued: 1, acknowledged: 1, attempts: 0 });
});
it('applies current label and content policy at prepare time without changing stored content', () => {
  const { archive, store, db } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); enable(store); ingest(archive);
  expect(lines(store.prepare()!.facts)[0].content_policy).toBe('metadata-only');
  store.configure({ ...config, includeBodies: true, sourceLabel: 'desk' }); store.clear(); ingest(archive, record(2));
  let line = lines(store.prepare()!.facts)[0]; expect(line).toMatchObject({ content_policy: 'included', source_label: 'desk', schema_version: 1 });
  expect(line.at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
  archive.setPolicy(DEFAULT_ARCHIVE_POLICY); expect(lines(store.prepare()!.facts)[0].content_policy).toBe('source-unavailable');
  expect((db.prepare('SELECT content FROM clickhouse_outbox LIMIT 1').get() as { content: string }).content).not.toContain('private-content');
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); store.clear();
  ingest(archive, record(3, { response: '\\'.repeat(1_000_000) }));
  expect(lines(store.prepare()!.facts)[0].content_policy).toBe('included');
  store.clear(); store.append(fact()); expect(lines(store.prepare()!.facts)[0].content_policy).toBe('source-unavailable');
});
it.each(['reopen', 'disabled', 'restart', 'timeout'])('emits finalized facts on %s settlement', (mode) => {
  const { db, archive, store } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); enable(store); observe(archive); store.clear();
  if (mode === 'reopen') new ArchiveStore(db, store);
  if (mode === 'disabled') archive.setPolicy(DEFAULT_ARCHIVE_POLICY);
  if (mode === 'restart') { ingest(archive, record(1, { traceId: 'other-trace' })); ingest(archive, record(1, { epoch: 'epoch-b', traceId: 'third-trace' })); }
  if (mode === 'timeout') archive.prune(Date.now() + 11 * 60_000, true);
  const finals = lines(store.prepare()!.facts).filter((r) => r.kind === 'finalized'); expect(finals).toHaveLength(1); expect(finals[0].trace_id).toBe('full-trace-0001');
});
it('pages backfill within a batch budget and pauses at the outbox budget', () => {
  const { archive, store, db } = setup();
  for (let n = 0; n < 3; n++) observe(archive, `backfill-trace-${n}`);
  db.prepare('UPDATE archive_entries SET model=?').run('x'.repeat(3 * 1024 * 1024));
  store.configure(config); const first = store.prepare()!; expect(first.rows).toBe(2); expect(store.status().backfilling).toBe(true);
  db.prepare('UPDATE clickhouse_outbox SET bytes=? WHERE seq=(SELECT min(seq) FROM clickhouse_outbox)').run(CLICKHOUSE_OUTBOX_BYTES);
  db.exec('UPDATE clickhouse_export SET queued_bytes=(SELECT sum(bytes) FROM clickhouse_outbox)');
  const queued = store.status().queued; store.prepare(); expect(store.status().queued).toBe(queued);
  store.acknowledge(first.token, first.destination); expect(store.prepare()!.rows).toBe(1); expect(store.status().backfilling).toBe(false);
});
it('clears outbox on archive clear and Activity clear', () => {
  const { archive, store, dir } = setup(); enable(store); observe(archive); archive.clear(); expect(store.status()).toMatchObject({ queued: 0, discarded: 1, backfilling: false });
  const log = new ActivityLog({ activityDb: path.join(dir, 'other.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 7 });
  try { log.clickhouseConfigure(config); log.clickhousePrepare(); log.archiveObserve(parseActivityEvent('{"request_id":"clear","trace_id":"clear-trace"}')!); log.clear(); expect(log.clickhouseStatus()).toMatchObject({ queued: 0, discarded: 1 }); } finally { log.close(); }
});
it('maintains queue totals through every removal path and caps backfill snapshots per step', () => {
  const { db, archive, store } = setup(); enable(store);
  const check = () => {
    const actual = db.prepare('SELECT count(*) AS queued,coalesce(sum(bytes),0) AS queuedBytes FROM clickhouse_outbox').get();
    expect(store.status()).toMatchObject(actual as { queued: number; queuedBytes: number });
  };
  store.append(fact()); check();
  const batch = store.prepare()!; store.acknowledge(batch.token, batch.destination); check();
  db.prepare("INSERT INTO clickhouse_outbox(kind,trace_id,at,capture_state,record,content,bytes) VALUES('attempt','budget',?,'','{}',NULL,?)").run(fact().at, CLICKHOUSE_OUTBOX_BYTES);
  check(); store.append(fact(1)); check(); expect(store.status()).toMatchObject({ queued: 1, discarded: 1 });
  store.clear(); check();
  const large = { ...fact(), record: { huge: '' } };
  const overhead = Buffer.byteLength(encodeClickHouseLine({ seq: Number.MAX_SAFE_INTEGER, kind: large.kind, trace_id: large.traceId, at: large.at, capture_state: large.captureState, record: JSON.stringify(large.record), content: null }, config, '0'.repeat(32), false));
  large.record.huge = 'x'.repeat(CLICKHOUSE_BATCH_BYTES - overhead);
  store.append(large); check(); store.configure({ ...config, sourceLabel: 'x'.repeat(CLICKHOUSE_SOURCE_LABEL_MAX) });
  expect(store.prepare()).toBeNull(); check(); expect(store.status().oversized).toBe(1);
  store.append(fact()); archive.clear(); check(); expect(store.status().queuedBytes).toBe(0);
  store.configure({ ...config, enabled: false });
  db.transaction(() => { for (let n = 0; n <= CLICKHOUSE_BATCH_ROWS; n++) observe(archive, `bounded-${n}`); })();
  store.configure(config); expect(store.prepare()!.rows).toBe(CLICKHOUSE_BATCH_ROWS); check();
  expect(store.status()).toMatchObject({ queued: CLICKHOUSE_BATCH_ROWS, backfilling: true });
  store.prepare(); check(); expect(store.status().queued).toBe(CLICKHOUSE_BATCH_ROWS + 1);
});
it.each([[false, true], [true, false]])('streams only metadata when includeBodies=%s and captureBodies=%s and stops at the byte boundary', (includeBodies, captureBodies) => {
  const { db, archive, store } = setup();
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies }); store.configure({ ...config, includeBodies }); store.prepare();
  for (let n = 0; n < 3; n++) store.append({ ...fact(n), record: { padding: 'x'.repeat(CLICKHOUSE_BATCH_BYTES / 2) }, content: { request: 'x'.repeat(CLICKHOUSE_BATCH_BYTES) } });
  const prepare = db.prepare.bind(db); let read = 0, selected = '';
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes('FROM clickhouse_outbox ORDER BY seq LIMIT ?')) {
      selected = sql;
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, 'iterate').mockImplementation(function* (...args: unknown[]) {
        for (const row of iterate(...args) as IterableIterator<OutboxRow>) { read++; expect(row.content).toBeNull(); yield row; }
      });
    }
    return statement;
  });
  const batch = store.prepare()!;
  expect(selected).toContain('NULL AS content'); expect(read).toBe(2); expect(batch.rows).toBe(1);
  expect(lines(batch.facts)[0].content_policy).toBe(includeBodies ? 'source-unavailable' : 'metadata-only');
  expect(Buffer.byteLength(batch.facts)).toBeLessThanOrEqual(CLICKHOUSE_BATCH_BYTES);
});
it('drops all v1 tables and triggers on open and preserves v2 rows', () => {
  const { db, store, file } = setup(); enable(store); store.append(fact());
  db.exec('CREATE TABLE clickhouse_state(n); CREATE TABLE clickhouse_queue(n); CREATE TABLE clickhouse_batch(n); CREATE TRIGGER clickhouse_old AFTER INSERT ON archive_entries BEGIN SELECT 1; END;'); db.close();
  const reopened = openActivityDb(file, 'ab'.repeat(32)); dbs.push(reopened);
  expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name IN ('clickhouse_state','clickhouse_queue','clickhouse_batch','clickhouse_old')").all()).toEqual([]);
  expect(new ClickHouseStore(reopened, new ArchiveStore(reopened)).status().queued).toBe(1);
});
it('accepts unversioned plain/shared/replicated engines and validates exact schema keys', async () => {
  const s = await server(), c = { ...config, endpoint: s.endpoint }, signal = new AbortController().signal;
  for (const engine of ['ReplacingMergeTree', 'ReplacingMergeTree()', "SharedReplacingMergeTree('/path,comma','replica') ORDER BY (source_id, at, seq)", "ReplicatedReplacingMergeTree('/path','{replica}')"]) { s.behavior.engine = engine; await expect(checkClickHouseSchema(c, undefined, signal)).resolves.toBeUndefined(); }
  for (const engine of ['MergeTree()', 'ReplacingMergeTree(revision)', "SharedReplacingMergeTree('/path','replica',seq)"]) { s.behavior.engine = engine; await expect(checkClickHouseSchema(c, undefined, signal)).rejects.toThrow(/schema v1/); }
  s.behavior.engine = 'ReplacingMergeTree'; s.behavior.partition = ''; await expect(checkClickHouseSchema(c, undefined, signal)).rejects.toThrow();
  s.behavior.partition = 'toYYYYMM(at)'; s.behavior.sorting = 'source_id,seq'; await expect(checkClickHouseSchema(c, undefined, signal)).rejects.toThrow();
  s.behavior.sorting = 'source_id,at,seq'; s.behavior.schema = false; await expect(checkClickHouseSchema(c, undefined, signal)).rejects.toThrow();
});
it('keeps uncertain inserts, drains continuously, caches schema and checks full responses', async () => {
  const s = await server(), { store } = setup(); store.configure({ ...config, endpoint: s.endpoint }); store.prepare(); store.append(fact());
  const upload = uploader(store); s.behavior.insertStatus = 500;
  expect(await upload.runOnce()).toBe(false); expect(store.status()).toMatchObject({ queued: 1, attempts: 1 });
  s.behavior.insertStatus = 200; store.retry(); expect(await upload.runOnce()).toBe(true);
  const inserts = s.requests.filter((r) => r.sql.startsWith('INSERT')); expect(inserts[0]!.sql).toBe(inserts[1]!.sql); expect(s.rows.size).toBe(1);
  const checks = s.requests.length; store.append(fact(2)); expect(await upload.runOnce()).toBe(true); expect(s.requests.length).toBe(checks + 1);
  expect(inserts[0]!.sql).toContain('async_insert=1, wait_for_async_insert=1'); expect(inserts[0]!.url).toBe('/?wait_end_of_query=1');
  s.behavior.insertBody = 'secret'; await expect(insertClickHouse({ ...config, endpoint: s.endpoint }, undefined, '{}\n', new AbortController().signal)).rejects.toThrow(/unexpected/);
  s.behavior.status = 401; await expect(clickhouseRequest({ ...config, endpoint: s.endpoint }, undefined, 'SELECT 1', new AbortController().signal)).rejects.toThrow(/HTTP 401/);
  expect(clickhouseTimeout(CLICKHOUSE_BATCH_BYTES)).toBeGreaterThan(120_000);
});
it('limits batches to 1000 rows and uses equal jitter state backoff', () => {
  const { store, db } = setup(); enable(store); db.transaction(() => { for (let n = 0; n <= CLICKHOUSE_BATCH_ROWS; n++) store.append(fact(n)); })();
  const batch = store.prepare()!; expect(batch.rows).toBe(CLICKHOUSE_BATCH_ROWS);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  for (let n = 0; n < 12; n++) { store.fail(batch.token, 1000, 'offline'); expect(store.status().nextAttemptAt).toBe(1000 + Math.min(300_000, 1000 * 2 ** Math.min(n, 9)) * 0.75); }
});
it('backfills retained content when enabled and when content export turns on', () => {
  const { archive, store } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); ingest(archive);
  store.configure(config); const metadata = store.prepare()!; expect(lines(metadata.facts)[0].kind).toBe('snapshot'); expect(metadata.facts).not.toContain('private-content'); store.acknowledge(metadata.token, metadata.destination);
  store.configure({ ...config, includeBodies: true }); expect(store.status().backfilling).toBe(true);
  const content = store.prepare()!; expect(content.pieces).toContain('private-content'); store.acknowledge(content.token, content.destination);
  archive.prune(Date.now() + 8 * 86_400_000, true); expect(store.status().queued).toBe(0);
});
it('marks queued content expired during an outage', () => {
  const { archive, store } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); store.configure({ ...config, includeBodies: true }); store.prepare(); ingest(archive);
  store.prepare(); archive.prune(Date.now() + 8 * 86_400_000, true);
  expect(archive.detail('full-trace-0001')!.state).toBe('expired'); expect(lines(store.prepare()!.facts)[0].content_policy).toBe('source-expired'); expect(store.status().contentExpired).toBe(1);
});
it('keeps continuous drain and the rejected-run scheduling backstop', async () => {
  const s = await server(), { store, db } = setup(); store.configure({ ...config, endpoint: s.endpoint }); store.prepare();
  db.transaction(() => { for (let n = 0; n <= CLICKHOUSE_BATCH_ROWS; n++) store.append(fact(n)); })();
  const upload = uploader(store);
  try { upload.start(); await vi.waitFor(() => expect(store.status().acknowledged).toBe(CLICKHOUSE_BATCH_ROWS + 1), { timeout: 2000 }); } finally { await upload.stop(); }
  expect(s.requests.filter((r) => r.sql.startsWith('INSERT'))).toHaveLength(2);
  vi.spyOn(upload, 'runOnce').mockRejectedValueOnce(new Error('escaped'));
  try { upload.start(); await vi.waitFor(() => expect(upload.error).toBe('ClickHouse delivery failed unexpectedly')); } finally { await upload.stop(); }
});

it('sends pieces before facts, resends after queue clear, and acknowledges only delivered pieces', async () => {
  const s = await server(), { store, archive, db } = setup();
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.configure({ ...config, endpoint: s.endpoint, includeBodies: true }); store.prepare(); ingest(archive);
  const first = store.prepare()!; expect(lines(first.pieces)).toHaveLength(1);
  expect(first.facts).not.toContain('private-content');
  store.clear(); ingest(archive, record(2));
  expect(store.prepare()!.pieces).toBe(first.pieces);
  expect(await uploader(store).runOnce()).toBe(true);
  const inserts = s.requests.filter((r) => r.sql.startsWith('INSERT'));
  expect(inserts).toHaveLength(2); expect(inserts[0]!.sql).toContain('_pieces`'); expect(inserts[1]!.sql).toContain('_facts`');
  expect(s.pieces.size).toBe(1); expect(s.rows.size).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM archive_pieces WHERE sent=1').get()).toEqual({ n: 1 });
  ingest(archive, record(3)); expect(store.prepare()!.pieces).toBe('');
  store.clear(); store.configure({ ...config, endpoint: s.endpoint, tablePrefix: 'changed', includeBodies: true });
  expect(store.prepare()!.pieces).toContain('private-content');
});
it('resends an unacknowledged piece after the outbox budget drops its fact', () => {
  const { store, archive, db } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.configure({ ...config, includeBodies: true }); store.prepare(); ingest(archive);
  const first = store.prepare()!;
  db.prepare('UPDATE clickhouse_outbox SET bytes=?').run(CLICKHOUSE_OUTBOX_BYTES);
  db.prepare('UPDATE clickhouse_export SET queued_bytes=?').run(CLICKHOUSE_OUTBOX_BYTES);
  ingest(archive, record(2));
  expect(store.status().discarded).toBe(1);
  expect(store.prepare()!.pieces).toBe(first.pieces);
});
it('includes escaped content above the normal batch limit', () => {
  const { store, archive, db } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.configure({ ...config, includeBodies: true }); store.prepare();
  ingest(archive, record(1, { request: '\\'.repeat(1_000_000), response: '\\'.repeat(1_000_000), frames: Array.from({ length: 8 }, (_, i) => ({ index: i, at: new Date().toISOString(), direction: 'response', type: 'text', truncated: false, payload: '\\'.repeat(190_000) })) }));
  const batch = store.prepare()!; expect(batch.pieces.length).toBeGreaterThan(0);
  expect(lines(batch.facts)[0].content_policy).toBe('included');
  store.acknowledge(batch.token, batch.destination);
  expect((db.prepare('SELECT count(*) AS n FROM archive_pieces WHERE sent=1').get() as { n: number }).n).toBeGreaterThan(0);
});
it('resets local v2 exporter state once and leaves the archive intact', () => {
  const { db, store, file, archive } = setup(); enable(store); store.append(fact());
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); ingest(archive);
  const source = db.prepare('SELECT source_id FROM clickhouse_export').get();
  db.exec("DELETE FROM archive_meta WHERE key='clickhouseV1'"); db.close();
  const reopened = openActivityDb(file, 'ab'.repeat(32)); dbs.push(reopened);
  const restored = new ArchiveStore(reopened), exporter = new ClickHouseStore(reopened, restored);
  expect(exporter.status().queued).toBe(0); expect(exporter.config()).toEqual(DEFAULT_CLICKHOUSE_CONFIG);
  expect(reopened.prepare('SELECT source_id FROM clickhouse_export').get()).not.toEqual(source);
  expect(restored.detail('full-trace-0001')?.request).toBe(record().request);
});
it.each(['pieces', 'thread'] as const)('expires unavailable %s and continues delivering subsequent facts', (missing) => {
  const { store, archive, db } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.configure({ ...config, includeBodies: true }); store.prepare(); ingest(archive);
  db.exec(missing === 'pieces' ? 'DELETE FROM archive_pieces' : 'DELETE FROM archive_threads');
  store.append(fact());
  const batch = store.prepare()!;
  expect(batch.pieces).toBe('');
  expect(lines(batch.facts)[0]).toMatchObject({ content_policy: 'source-expired', request_pieces: [], response: '', frames_json: '' });
  expect(lines(batch.facts)).toHaveLength(2);
  store.acknowledge(batch.token, batch.destination); expect(store.status().queued).toBe(0);
});

it('ships a large single capture with all required pieces in one batch', () => {
  const { archive, store } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.configure({ ...config, includeBodies: true }); store.prepare();
  const request = 'x'.repeat(CAPTURE_BODY_LIMIT);
  ingest(archive, record(1, { request }));
  const batch = store.prepare()!;
  expect(Buffer.byteLength(batch.facts + batch.pieces)).toBeGreaterThan(CLICKHOUSE_BATCH_BYTES);
  const capture = lines(batch.facts).find((f) => f.kind === 'capture');
  expect(capture.content_policy).toBe('included');
  const pieces = new Map(lines(batch.pieces).map((p) => [p.seq, p.bytes]));
  expect(capture.request_pieces.map(({ piece_seq: id, offset, length }: { piece_seq: number; offset: number; length: number }) => pieces.get(id).slice(offset, offset + length)).join('')).toBe(request);
  store.acknowledge(batch.token, batch.destination); expect(store.status().queued).toBe(0);
});

it('exports dictionary-compressed request pieces as plain text bytes', () => {
  const { db, archive, store } = setup();
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  store.configure({ ...config, includeBodies: true }); store.prepare();
  ingest(archive, record(1, { request: 'prefix first suffix' }));
  const first = store.prepare()!; store.acknowledge(first.token, first.destination);
  ingest(archive, record(2, { request: 'prefix second suffix' }));
  const piece = db.prepare('SELECT id,dict FROM archive_pieces WHERE dict IS NOT NULL').get() as { id: number; dict: string };
  expect(JSON.parse(piece.dict).length).toBeGreaterThan(0);
  expect(lines(store.prepare()!.pieces)).toContainEqual(expect.objectContaining({ seq: piece.id, bytes: 'second' }));
});

it('names the setup step for HTTP failures without echoing the body', async () => {
  for (const [status, hint] of [[403, 'grants'], [404, 'Create table'], [500, 'server or schema failure']] as const) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('secret echo', { status }));
    const failure = clickhouseRequest(config, undefined, 'SELECT 1', new AbortController().signal);
    await expect(failure).rejects.toThrow(`ClickHouse HTTP ${status}`);
    await expect(failure).rejects.toThrow(hint);
    await expect(failure).rejects.not.toThrow('secret echo');
  }
});

it('matches pretty-printed ClickHouse types but not different ones', () => {
  const compact = 'Array(Tuple(piece_seq UInt64, offset UInt32, length UInt32))';
  expect(sameClickHouseType('Array(Tuple(\n    piece_seq UInt64,\n    offset UInt32,\n    length UInt32))', compact)).toBe(true);
  expect(sameClickHouseType('Array(Tuple(\n    piece_seq UInt64,\n    offset UInt64,\n    length UInt32))', compact)).toBe(false);
  expect(sameClickHouseType("DateTime64(3,'UTC')", "DateTime64(3, 'UTC')")).toBe(true);
});

it('keeps the source label across a reopen', () => {
  const { db, store, file } = setup();
  store.configure({ ...config, sourceLabel: 'desktop-dev' }); db.close();
  const reopened = openActivityDb(file, 'ab'.repeat(32)); dbs.push(reopened);
  let again: ClickHouseStore;
  const archive = new ArchiveStore(reopened, { append: (f) => again.append(f) }); again = new ClickHouseStore(reopened, archive);
  expect(again.config().sourceLabel).toBe('desktop-dev');
});

it('reports missing tables so the page can offer Create tables', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('1\n')).mockResolvedValueOnce(new Response('', { status: 404 }));
  await expect(checkClickHouseSchema(config, undefined, new AbortController().signal)).rejects.toThrow(CLICKHOUSE_TABLES_MISSING);
});
