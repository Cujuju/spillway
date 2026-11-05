import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import * as io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY, type CaptureRecord } from '@shared/archive';
import { EXPORT_MAX_RECORD_BYTES, EXPORT_PREVIEW_TTL_MS, type ArchiveExportJob, type PortableCapture, type PortableManifest, type PortableTrailer } from '@shared/archiveExport';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
import { ArchiveExporter, normalizeExportOptions } from './archiveExport';
import { parseActivityEvent } from './sse';
import { ActivityLog } from './activityStore';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

const dirs: string[] = [], dbs: Db[] = [], exporters: ArchiveExporter[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const exporter of exporters.splice(0)) await exporter.dispose();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-portable-')); dirs.push(dir);
  const file = path.join(dir, 'activity.db'), db = openActivityDb(file, 'ab'.repeat(32)); dbs.push(db);
  const store = new ArchiveStore(db); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  const exporter = new ArchiveExporter(db, store); exporters.push(exporter);
  return { dir, file, db, store, exporter };
}
function fixture(sequence = 1, extra: Partial<CaptureRecord> = {}): CaptureRecord {
  return { id: `capture-${sequence}`, traceId: `full-trace-${sequence}`, epoch: 'epoch-a', sequence, startedAt: new Date().toISOString(),
    method: 'POST', path: '/v1/messages', status: 200, state: 'complete', reason: '',
    request: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'résumé\n東京' }] }], tools: [{ name: 'lookup', input_schema: { type: 'object' } }] }),
    response: 'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool-2","name":"lookup","input":{}}}\n\ndata: {"delta":{"partial_json":"{\\"q\\":\\"next\\"}"}}\n\n',
    requestType: 'application/json', responseType: 'text/event-stream', requestEncoding: '', responseEncoding: '', requestDecoded: true, responseDecoded: true, ...extra };
}
function ingest(store: ArchiveStore, records: CaptureRecord[]) { store.ingest({ version: 1, epoch: 'epoch-a', dropped: 2, records }); }
function observe(store: ArchiveStore, sequence = 1) {
  store.observe(parseActivityEvent(JSON.stringify({ trace_id: `full-trace-${sequence}`, request_id: `attempt-${sequence}`, selection_id: `selection-${sequence}`, provider: 'claude', alias: 'requested-alias', model: 'effective-model', reasoning_effort: 'high', client: 'ignored-by-parser', user_agent: 'claude-cli/1', session_id: 'claude:conversation', parent_session_id: 'claude:parent', downstream_transport: 'http', upstream_transport: 'websocket+http', transport_fallback_reason: 'websocket_dial_failed', latency_ms: 23, ttft_ms: 5 }))!);
}
async function finish(exporter: ArchiveExporter, job: ArchiveExportJob, file: string) {
  exporter.start(job.id, file);
  await vi.waitFor(() => expect(['preview', 'writing', 'finalizing']).not.toContain(exporter.status(job.id).state));
  return exporter.status(job.id);
}
function read(file: string) {
  const bytes = readFileSync(file), lines = bytes.toString('utf8').trimEnd().split('\n');
  const manifest = JSON.parse(lines[0]!) as PortableManifest, trailer = JSON.parse(lines.at(-1)!) as PortableTrailer;
  const captures = lines.slice(1, -1).map((line) => JSON.parse(line) as PortableCapture);
  const prefix = Buffer.from(`${lines.slice(0, -1).join('\n')}\n`, 'utf8');
  expect(trailer.type).toBe('complete'); expect(trailer.sha256).toBe(createHash('sha256').update(prefix).digest('hex'));
  expect(trailer.bytesBeforeTrailer).toBe(prefix.length); expect(trailer.records).toBe(captures.length);
  expect(manifest.records).toBe(captures.length); expect(bytes.length).toBeLessThan(EXPORT_MAX_RECORD_BYTES * lines.length);
  return { manifest, captures, trailer };
}
function snapshotCount(db: Db) { return (db.prepare('SELECT count(*) AS n FROM portable_export_snapshot').get() as { n: number }).n; }

it('exports metadata by default with explicit omission, full stable IDs and no raw prompts or arbitrary attempt fields', async () => {
  const { store, exporter, db, dir } = setup(); observe(store); ingest(store, [fixture()]);
  db.prepare("UPDATE archive_attempts SET detail=json_set(detail,'$.credential','AUTH-SECRET','$.provenance.authIndex','ACCOUNT-SECRET')").run();
  const job = exporter.prepare({}), file = path.join(dir, 'export.jsonl');
  expect(job.manifest.rawPayloads).toBe('omitted'); expect(await finish(exporter, job, file)).toMatchObject({ state: 'complete', writtenRecords: 1, path: file });
  const { captures } = read(file), r = captures[0]!;
  expect(r.entry).toMatchObject({ id: 'trace:full-trace-1', captureId: 'capture-1', captureEpoch: 'epoch-a', captureSequence: 1, state: 'complete' });
  expect(r.payload).toMatchObject({ state: 'omitted', data: null, sha256: null });
  expect(r.attempts[0]?.provenance).toMatchObject({ model: 'requested-alias', effectiveModel: 'effective-model', reasoningEffort: 'high', parentSessionId: 'claude:parent', upstreamTransport: 'websocket+http' });
  expect(readFileSync(file, 'utf8')).not.toMatch(/AUTH-SECRET|ACCOUNT-SECRET|résumé|tool_result/);
  expect(snapshotCount(db)).toBe(0);
});

it('preserves raw Claude tools and SSE, UTF-8 bytes and payload hashes without inferring task success', async () => {
  const { store, exporter, dir } = setup(); observe(store); const capture = fixture(); ingest(store, [capture]);
  const file = path.join(dir, 'raw.jsonl'); await finish(exporter, exporter.prepare({ includeRecordedBodies: true }), file);
  const { manifest, captures, trailer } = read(file), r = captures[0]!;
  expect(manifest.taskOutcome).toBe('unknown'); expect(r.entry.status).toBe(200);
  expect(r.payload.data).toMatchObject({ request: capture.request, response: capture.response, requestDecoded: true });
  expect(r.payload.sha256).toBe(createHash('sha256').update(JSON.stringify(r.payload.data), 'utf8').digest('hex'));
  expect(trailer.payloadStates).toEqual({ included: 1, omitted: 0, unavailable: 0, malformed: 0 });
});

it('freezes exact body revisions, attempts and selection through concurrent capture, expiry and deletion', async () => {
  const { store, exporter, dir } = setup(); observe(store); ingest(store, [fixture()]);
  const job = exporter.prepare({ query: { sessionId: 'claude:conversation' }, includeRecordedBodies: true });
  ingest(store, [fixture(2, { traceId: 'full-trace-1', response: 'new revision', state: 'partial' })]);
  store.clear(); ingest(store, [fixture(3)]);
  const file = path.join(dir, 'snapshot.jsonl'); await finish(exporter, job, file);
  const { captures } = read(file); expect(captures).toHaveLength(1); expect(captures[0]!.entry.state).toBe('complete');
  expect(captures[0]!.payload.data?.response).toBe(fixture().response); expect(captures[0]!.attempts).toHaveLength(1);
});

it('selects every page in an inclusive date range intersecting conversation and IDs, and reports missing selections', async () => {
  const { store, exporter, db, dir } = setup();
  const at = Date.now() - 1000;
  for (let i = 1; i <= 55; i++) { observe(store, i); ingest(store, [fixture(i, { startedAt: new Date(at).toISOString() })]); }
  db.prepare('UPDATE archive_entries SET at=?').run(new Date(at).toISOString());
  const all = exporter.prepare({ query: { sessionId: 'claude:conversation', from: new Date(at).toISOString(), to: new Date(at).toISOString() } });
  expect(all.manifest.records).toBe(55);
  const full = exporter.prepare({ query: { sessionId: 'claude:conversation', from: new Date(at).toISOString() } });
  expect(full.manifest.records).toBe(55);
  const single = exporter.prepare({ query: { sessionId: 'claude:conversation' }, ids: ['trace:full-trace-2', 'trace:absent-trace'] });
  expect(single.manifest.unresolvedIds).toEqual(['trace:absent-trace']);
  const file = path.join(dir, 'single.jsonl'); await finish(exporter, single, file); expect(read(file).captures[0]?.entry.traceId).toBe('full-trace-2');
});

it('retains explicit missing, expired, pending, partial and malformed payload states and old unknown provenance', async () => {
  const { store, exporter, db, dir } = setup();
  ingest(store, [fixture(1, { state: 'partial', reason: 'byte-limit' }), fixture(2, { state: 'missing', request: '', response: '' }), fixture(3, { state: 'pending', reason: 'websocket-open', format: 'websocket' }), fixture(4)]);
  db.exec("UPDATE archive_entries SET detail='{broken' WHERE trace_id='full-trace-4'; UPDATE archive_entries SET state='expired',bytes=0,detail='{}' WHERE trace_id='full-trace-2'");
  store.observe(parseActivityEvent('{"trace_id":"missing-trace","request_id":"old-link"}')!);
  db.exec("UPDATE archive_attempts SET detail=json_remove(detail,'$.provenance')");
  const file = path.join(dir, 'states.jsonl'); await finish(exporter, exporter.prepare({ includeRecordedBodies: true }), file);
  const { captures } = read(file), byId = new Map(captures.map((r) => [r.entry.traceId, r]));
  expect(byId.get('full-trace-1')?.payload.state).toBe('included'); expect(byId.get('full-trace-1')?.entry.state).toBe('partial');
  expect(byId.get('full-trace-2')).toMatchObject({ entry: { state: 'expired' }, payload: { state: 'unavailable' } });
  expect(byId.get('full-trace-3')?.entry.state).toBe('pending'); expect(byId.get('full-trace-4')?.payload.state).toBe('malformed');
  expect(byId.get('missing-trace')?.attempts[0]?.provenance).toBeNull();
});

it('preserves ordered Codex WS application messages including binary and truncation labels', async () => {
  const { store, exporter, dir } = setup();
  const frames: NonNullable<CaptureRecord['frames']> = [{ index: 0, direction: 'request', at: new Date().toISOString(), type: 'text', payload: '{"type":"response.create","response":{"input":[{"type":"function_call_output","call_id":"c1","output":"ok"}]}}', truncated: false },
    { index: 1, direction: 'response', at: new Date().toISOString(), type: 'binary', payload: 'AAEC', truncated: true }];
  ingest(store, [fixture(1, { format: 'websocket', state: 'partial', reason: 'frame-limit', frames })]);
  const file = path.join(dir, 'ws.jsonl'); await finish(exporter, exporter.prepare({ includeRecordedBodies: true }), file);
  expect(read(file).captures[0]!.payload.data).toMatchObject({ format: 'websocket', frames });
});

it('cancels streaming without replacing an existing destination and removes incomplete output and snapshots', async () => {
  const { store, exporter, db, dir } = setup(); ingest(store, [fixture(1, { request: 'x'.repeat(1_000_000) })]);
  const file = path.join(dir, 'existing.jsonl'); writeFileSync(file, 'keep'); const job = exporter.prepare({ includeRecordedBodies: true });
  exporter.start(job.id, file); exporter.cancel(job.id); await exporter.dispose();
  expect(exporter.status(job.id).state).toBe('canceled'); expect(readFileSync(file, 'utf8')).toBe('keep');
  expect(readdirSync(dir).filter((s) => s.endsWith('.partial'))).toEqual([]); expect(snapshotCount(db)).toBe(0);
});

it('reports disk open/rename errors without producing a completed export and preserves the destination', async () => {
  const { store, exporter, dir } = setup(); ingest(store, [fixture()]);
  const missing = path.join(dir, 'absent', 'out.jsonl');
  expect(await finish(exporter, exporter.prepare({}), missing)).toMatchObject({ state: 'failed', path: null }); expect(existsSync(missing)).toBe(false);
  expect(await finish(exporter, exporter.prepare({}), dir)).toMatchObject({ state: 'failed', path: null });
  expect(readdirSync(dir).filter((s) => s.endsWith('.partial'))).toEqual([]);
});

it('handles a disk-full write error, cleans the partial file and leaves the prior destination intact', async () => {
  const { store, exporter, dir } = setup(); ingest(store, [fixture()]); const file = path.join(dir, 'prior'); writeFileSync(file, 'prior');
  const original = vi.mocked(io.open).getMockImplementation()!;
  vi.mocked(io.open).mockImplementationOnce(async (...args) => {
    const handle = await original(...args); vi.spyOn(handle, 'write').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' })); return handle;
  });
  const result = await finish(exporter, exporter.prepare({}), file);
  expect(result).toMatchObject({ state: 'failed', path: null, error: 'disk full' }); expect(readFileSync(file, 'utf8')).toBe('prior');
  expect(readdirSync(dir).filter((s) => s.endsWith('.partial'))).toEqual([]);
});

it('expires abandoned previews and bounds one encrypted snapshot without retaining raw bodies after cleanup', async () => {
  vi.useFakeTimers(); const { store, exporter, db, file } = setup(); ingest(store, [fixture()]);
  const job = exporter.prepare({ includeRecordedBodies: true }); expect(snapshotCount(db)).toBe(1);
  db.pragma('wal_checkpoint(TRUNCATE)'); expect(readFileSync(file).includes(Buffer.from('tool_result'))).toBe(false);
  vi.advanceTimersByTime(EXPORT_PREVIEW_TTL_MS + 1); expect(exporter.status(job.id).state).toBe('expired'); expect(snapshotCount(db)).toBe(0);
});

it('cleans stale encrypted snapshots and owned incomplete files on worker restart', async () => {
  const { store, exporter, db, dir } = setup(); await exporter.dispose();
  const temp = path.join(dir, '.spillway-export-12345678-1234-1234-1234-123456789abc.partial'); writeFileSync(temp, 'incomplete');
  db.prepare('INSERT INTO portable_export_temp VALUES(?)').run(temp); db.exec("INSERT INTO portable_export_snapshot VALUES(1,'{}','private old detail','[]')");
  const reopened = new ArchiveExporter(db, store); exporters.push(reopened);
  expect(snapshotCount(db)).toBe(0); expect(existsSync(temp)).toBe(false);
});

it('enforces snapshot and record budgets atomically, and streams large escaped records above 64 KiB', async () => {
  const { store, exporter, db, dir } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true, maxBytes: 1024 * 1024 }); ingest(store, [fixture()]);
  db.prepare('UPDATE archive_entries SET detail=?').run('x'.repeat(18 * 1024 * 1024));
  expect(() => exporter.prepare({ includeRecordedBodies: true })).toThrow('snapshot limit'); expect(snapshotCount(db)).toBe(0);
  db.prepare('UPDATE archive_entries SET detail=?').run('x'.repeat(EXPORT_MAX_RECORD_BYTES + 1));
  expect(() => exporter.prepare({ includeRecordedBodies: true })).toThrow('32 MiB'); expect(snapshotCount(db)).toBe(0);
  expect(exporter.prepare({}).manifest.records).toBe(1);
  ingest(store, [fixture(2, { traceId: 'full-trace-1', request: '\n東京'.repeat(60_000) })]);
  const file = path.join(dir, 'large.jsonl'); expect(await finish(exporter, exporter.prepare({ includeRecordedBodies: true }), file)).toMatchObject({ state: 'complete' });
  expect(read(file).captures[0]!.payload.data?.request).toBe('\n東京'.repeat(60_000));
});

it('rejects malformed selections rather than broadening them silently', () => {
  expect(() => normalizeExportOptions({ query: { from: 'broken' } })).toThrow('date');
  expect(() => normalizeExportOptions({ query: { from: '2026-11-06', to: '2026-11-05' } })).toThrow('start');
  expect(() => normalizeExportOptions({ ids: [] })).toThrow('stable');
  expect(() => normalizeExportOptions({ query: { before: 'cursor' } } as never)).toThrow('whole filter');
  for (const raw of [null, [], { includeRecordedBodies: 'yes' }, { query: [] }, { query: { model: 4 } }, { query: { state: 'success' } }, { ids: ['short'] }, { ids: new Array(1001).fill('trace:full-trace-1') }]) expect(() => normalizeExportOptions(raw as never)).toThrow();
});

it('marks malformed attempt links explicitly while preserving valid capture content', async () => {
  const { store, exporter, db, dir } = setup(); observe(store); ingest(store, [fixture()]);
  db.exec("UPDATE archive_attempts SET detail='{broken'"); const file = path.join(dir, 'bad-links.jsonl');
  await finish(exporter, exporter.prepare({ includeRecordedBodies: true }), file);
  expect(read(file).captures[0]).toMatchObject({ attemptsState: 'malformed', attempts: [], payload: { state: 'included' } });
});

it('keeps new attempt provenance after Activity retention/body expiry and cancels jobs on explicit archive deletion', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-portable-log-')); dirs.push(dir);
  const log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 1 });
  try {
    log.archiveExportReset(); log.archivePolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
    const at = new Date(Date.now() - 2 * 86400_000).toISOString();
    const e = { ...parseActivityEvent('{"trace_id":"full-trace-1","request_id":"attempt-1","model":"upstream","alias":"alias","reasoning_effort":"high"}')!, at };
    log.append(e); log.archiveObserve(e); log.archiveIngest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [fixture(1, { startedAt: at })] });
    log.prune(); log.archivePolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: false, retentionDays: 1 });
    expect(log.archiveDetail('full-trace-1')).toMatchObject({ state: 'expired', attempts: [{ provenance: { model: 'alias', effectiveModel: 'upstream', reasoningEffort: 'high' } }] });
    const preview = log.archiveExportPrepare({ includeRecordedBodies: true }); log.archiveClear();
    expect(log.archiveExportStatus(preview.id).state).toBe('canceled'); expect(log.archiveQuery({}).entries).toHaveLength(0);
  } finally { await log.archiveExportDispose(); log.close(); }
});

it('treats atomic rename as the non-cancelable commit point and replaces an approved existing file only after a verified stream', async () => {
  const { store, exporter, dir } = setup(); ingest(store, [fixture()]);
  const original = vi.mocked(io.rename).getMockImplementation()!;
  let release!: () => void; const ready = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(io.rename).mockImplementationOnce(async (...args) => { await ready; await original(...args); });
  const file = path.join(dir, 'replace.jsonl'); writeFileSync(file, 'existing'); const job = exporter.prepare({});
  exporter.start(job.id, file);
  try {
    await vi.waitFor(() => expect(exporter.status(job.id).state).toBe('finalizing'));
    expect(exporter.cancel(job.id).state).toBe('finalizing'); expect(readFileSync(file, 'utf8')).toBe('existing');
  } finally { release(); }
  await vi.waitFor(() => expect(exporter.status(job.id).state).toBe('complete')); read(file);
});

it('isolates locked crash-leftover cleanup, keeps its recovery marker and retries without breaking Activity', async () => {
  const { store, exporter, db, dir } = setup(); await exporter.dispose();
  const locked = path.join(dir, '.spillway-export-11111111-1234-1234-1234-123456789abc.partial');
  const clean = path.join(dir, '.spillway-export-22222222-1234-1234-1234-123456789abc.partial');
  for (const file of [locked, clean]) { writeFileSync(file, 'incomplete'); db.prepare('INSERT INTO portable_export_temp VALUES(?)').run(file); }
  db.exec("INSERT INTO portable_export_snapshot VALUES(1,'{}','stale private content','[]')");
  const original = vi.mocked(unlinkSync).getMockImplementation()!;
  vi.mocked(unlinkSync).mockImplementation((file) => {
    if (file === locked) throw Object.assign(new Error('held by antivirus'), { code: 'EPERM' }); original(file);
  });
  const recovered = new ArchiveExporter(db, store); exporters.push(recovered);
  expect(recovered.cleanupWarning).toContain(locked); expect(snapshotCount(db)).toBe(0);
  expect(existsSync(locked)).toBe(true); expect(existsSync(clean)).toBe(false);
  expect(db.prepare('SELECT path FROM portable_export_temp').all()).toEqual([{ path: locked }]);
  observe(store); ingest(store, [fixture()]); expect(store.query({}).entries).toHaveLength(1);
  expect(() => recovered.prepare({})).toThrow('Resolve incomplete-file cleanup');
  vi.mocked(unlinkSync).mockImplementation(original);
  expect(recovered.prepare({}).manifest.records).toBe(1); expect(recovered.cleanupWarning).toBeNull(); expect(existsSync(locked)).toBe(false);
});

it('reports an unsafe recovery marker without deleting its target or stopping archive operations', async () => {
  const { store, exporter, db, dir } = setup(); await exporter.dispose();
  const unsafe = path.join(dir, 'unrelated.txt'); writeFileSync(unsafe, 'keep'); db.prepare('INSERT INTO portable_export_temp VALUES(?)').run(unsafe);
  const recovered = new ArchiveExporter(db, store); exporters.push(recovered);
  expect(recovered.cleanupWarning).toContain('Invalid incomplete export path'); expect(readFileSync(unsafe, 'utf8')).toBe('keep');
  expect(() => recovered.prepare({})).toThrow('Resolve incomplete-file cleanup');
  observe(store); expect(store.query({}).entries).toHaveLength(1);
});

it('preserves completed status/path with a cleanup warning after successful rename', async () => {
  const { store, exporter, db, dir } = setup(); ingest(store, [fixture()]); const file = path.join(dir, 'committed.jsonl'); writeFileSync(file, 'prior');
  db.exec("CREATE TRIGGER block_snapshot_cleanup BEFORE DELETE ON portable_export_snapshot BEGIN SELECT RAISE(ABORT,'cleanup disk error'); END");
  try {
    const result = await finish(exporter, exporter.prepare({}), file);
    expect(result).toMatchObject({ state: 'complete', path: file, error: null, warning: expect.stringContaining('cleanup disk error') });
    expect(exporter.cleanupWarning).toContain('cleanup disk error'); read(file);
  } finally { db.exec('DROP TRIGGER block_snapshot_cleanup'); }
  expect(exporter.prepare({}).state).toBe('preview');
});

it('preserves long stable attempt identifiers exactly within the bounded link budget', async () => {
  const { store, exporter, dir } = setup(), requestId = `execution-${'x'.repeat(2048)}`;
  store.observe(parseActivityEvent(JSON.stringify({ trace_id: 'full-trace-1', request_id: requestId }))!); ingest(store, [fixture()]);
  const file = path.join(dir, 'long-identity.jsonl'); await finish(exporter, exporter.prepare({}), file);
  expect(read(file).captures[0]).toMatchObject({ attemptsState: 'recorded', attempts: [{ requestId }] });
});
