import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EVAL_LIMITS } from '@shared/evalCase';
import { DEFAULT_ARCHIVE_POLICY } from '@shared/archive';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
import { ActivityLog } from './activityStore';
import { ArchiveExporter } from './archiveExport';
import { EvalCaseStore } from './evalCaseStore';
import { decodeCaseFile, encodeCaseFile, redactExport, sha256, validateCase } from './evalCaseCodec';
import { annotation, captureRecord, evalFixture } from './test/evalFixtures';

const dirs: string[] = [], dbs: Db[] = [];
function uncheckedCaseRows(rows: unknown[]): string {
  const prefix = `${JSON.stringify({ type: 'manifest', format: 'spillway.eval-cases', version: 1, records: rows.length, taskOutcome: 'unknown' })}\n${rows.map((r) => `${JSON.stringify(r)}\n`).join('')}`;
  return `${prefix}${JSON.stringify({ type: 'complete', records: rows.length, bytesBeforeTrailer: Buffer.byteLength(prefix), sha256: sha256(prefix) })}\n`;
}
function uncheckedCaseFile(c: unknown): string {
  return uncheckedCaseRows([c]);
}
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-eval-')); dirs.push(dir);
  const file = path.join(dir, 'activity.db'), db = openActivityDb(file, 'ab'.repeat(32)); dbs.push(db);
  const archive = new ArchiveStore(db); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  archive.ingest({ version: 1, epoch: 'test-epoch', dropped: 0, records: [captureRecord()] });
  return { db, file, dir, archive, store: new EvalCaseStore(db, archive) };
}
it('pins encrypted immutable snapshots through expiry, archive deletion, close and reopen', () => {
  const { store, archive, db, file } = setup();
  const op = randomUUID(), c = store.create(op, 'trace-synthetic-001', annotation(), true);
  expect(store.create(op, 'trace-synthetic-001', annotation(), true)).toEqual(c);
  archive.prune(Date.now() + 30 * 86_400_000, true); archive.clear();
  expect(store.get(c.id)).toEqual(c);
  const next = store.revise(randomUUID(), c.id, 1, { ...annotation(), notes: 'new notes' });
  expect(next.revision).toBe(2); expect(store.get(c.id, 1)).toEqual(c);
  expect(() => store.revise(randomUUID(), c.id, 1, annotation())).toThrow('reload');
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  expect(readFileSync(file).includes(Buffer.from('Say hello'))).toBe(false);
  const reopened = openActivityDb(file, 'ab'.repeat(32)); dbs.push(reopened);
  const restored = new EvalCaseStore(reopened, new ArchiveStore(reopened)); expect(restored.get(c.id)).toEqual(next);
  restored.delete(c.id); expect(restored.list()).toEqual([]); expect(() => restored.get(c.id, 1)).toThrow();
});
it('metadata snapshots preserve omitted state and missing source fails without creating a case', () => {
  const { store } = setup();
  expect(store.create(randomUUID(), 'trace-synthetic-001', annotation(), false).capture.payload).toMatchObject({ state: 'omitted', data: null });
  expect(() => store.create(randomUUID(), 'trace-does-not-exist', annotation(), true)).toThrow();
  expect(store.list()).toHaveLength(1);
});
it('whole Activity clear removes cases while archive clear preserves them', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-eval-log-')); dirs.push(dir);
  const log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 7 });
  try {
    log.archivePolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); log.archiveIngest({ version: 1, epoch: 'test-epoch', dropped: 0, records: [captureRecord()] });
    log.evalCreate(randomUUID(), 'trace-synthetic-001', annotation(), true); log.archiveClear(); expect(log.evalList()).toHaveLength(1);
    log.clear(); expect(log.evalList()).toEqual([]);
  } finally { log.close(); }
});
it('bounds case revisions, per-case storage and global pinned storage without eviction', () => {
  const { store, db } = setup(); const c = store.create(randomUUID(), 'trace-synthetic-001', annotation(), true);
  for (let n = 1; n < EVAL_LIMITS.revisions; n++) store.revise(randomUUID(), c.id, n, annotation());
  expect(() => store.revise(randomUUID(), c.id, 8, annotation())).toThrow(); expect(store.get(c.id, 1)).toEqual(c);
  db.prepare('UPDATE eval_cases SET bytes=? WHERE id=? AND revision=1').run(EVAL_LIMITS.caseBytes, c.id);
  expect(() => store.import(Buffer.from(encodeCaseFile({ ...c, revision: 2, parentRevision: 1, createdAt: '2020-01-01T00:00:00Z' })))).toThrow();
  db.exec('DELETE FROM eval_cases');
  const d = store.create(randomUUID(), 'trace-synthetic-001', annotation(), true);
  db.prepare('UPDATE eval_cases SET bytes=? WHERE id=?').run(EVAL_LIMITS.totalBytes, d.id);
  expect(() => store.create(randomUUID(), 'trace-synthetic-001', annotation(), true)).toThrow('storage limit'); expect(store.list()).toHaveLength(1);
  const huge = evalFixture(); huge.annotation.notes = 'a'.repeat(EVAL_LIMITS.snapshotBytes); expect(() => store.import(Buffer.from(encodeCaseFile(huge)))).toThrow();
});
it('imports eval case bytes atomically, detects conflicts and preserves unknown forward-compatible content', () => {
  const { store } = setup(); const c = { ...evalFixture(), future: { opaque: 'protocol data' } };
  const bytes = Buffer.from(encodeCaseFile(c)); store.import(bytes); store.import(bytes);
  expect(store.get(c.id)).toEqual({ ...c, provenance: { source: 'portable-import', archiveId: c.capture.entry.id, importedFrom: sha256(bytes) } });
  const changed = { ...c, annotation: { ...c.annotation, title: 'conflicting revision' } };
  expect(() => store.import(Buffer.from(encodeCaseFile(changed)))).toThrow('conflicts'); expect(store.list()).toHaveLength(1);
  for (const invalid of [bytes.subarray(0, -1), Buffer.from(bytes.toString().replace('Synthetic', 'Tampered')), Buffer.from(bytes.toString().replaceAll('\n', '\r\n')), Buffer.concat([bytes, Buffer.from('{}\n')]), Buffer.from([0xff, 10]), Buffer.concat([Buffer.from('\uFEFF'), bytes])]) expect(() => decodeCaseFile(invalid)).toThrow();
});
it('validates versions, counts, identity, assertions and payload digests even with a valid trailer', () => {
  const c = evalFixture();
  for (const modify of [
    (v: typeof c) => { v.schemaVersion = 2 as 1; },
    (v: typeof c) => { v.capture.entry.id = 'trace:fake-identity'; },
    (v: typeof c) => { v.capture.payload.sha256 = '0'.repeat(64); },
    (v: typeof c) => { v.annotation.assertions = [{ kind: 'shell' as 'contains', value: 'execute me' }]; },
    (v: typeof c) => { v.capture.payload.state = 'omitted'; },
    (v: typeof c) => { v.taskOutcome = 'success' as 'unknown'; },
  ]) { const v = structuredClone(c); modify(v); expect(() => decodeCaseFile(Buffer.from(uncheckedCaseFile(v)))).toThrow(); }
  expect(() => decodeCaseFile(Buffer.from(encodeCaseFile(c).replace('"records":1', '"records":2')))).toThrow();
  expect(() => validateCase({ ...c, annotation: null })).toThrow();
});
it('consumes integrated portable JSONL exports only after trailer verification and retains protocol states', async () => {
  const { db, archive, store, dir } = setup(), exporter = new ArchiveExporter(db, archive);
  const job = exporter.prepare({ includeRecordedBodies: true }), file = path.join(dir, 'archive.jsonl');
  exporter.start(job.id, file);
  await viWait(() => exporter.status(job.id).state !== 'writing' && exporter.status(job.id).state !== 'finalizing');
  expect(exporter.status(job.id).state).toBe('complete');
  const imported = store.import(readFileSync(file)); expect(imported).toHaveLength(1);
  expect(store.get(imported[0]!.id).capture.payload.state).toBe('included'); store.import(readFileSync(file)); expect(store.list()).toHaveLength(1);
  await exporter.dispose();
});
it('rejects duplicate identities and rolls back all imported cases if a later case conflicts', () => {
  const { store } = setup(), a = evalFixture(); store.import(Buffer.from(encodeCaseFile(a)));
  const b = { ...a, id: `case:${randomUUID()}` }, conflict = { ...a, annotation: { ...a.annotation, title: 'conflict' } };
  const file = (rows: unknown[]) => Buffer.from(uncheckedCaseRows(rows));
  expect(() => store.import(file([b, conflict]))).toThrow(); expect(store.list()).toHaveLength(1);
  expect(() => store.import(file([b, b]))).toThrow('duplicate');
});
it('rejects foreign captures and skipped revisions in an existing family, rolling back earlier rows', () => {
  const { store } = setup(), local = store.create('20000000-0000-4000-8000-000000000001', 'trace-synthetic-001', annotation(), true);
  const fresh = { ...evalFixture(), id: 'case:00000000-0000-4000-8000-000000000000' };
  const next = { ...structuredClone(local), revision: 2, parentRevision: 1, annotation: { ...annotation(), notes: 'imported revision' } };
  next.capture.payload.data!.request = '{"model":"foreign","messages":[{"role":"user","content":"changed"}]}'; next.capture.payload.sha256 = sha256(JSON.stringify(next.capture.payload.data));
  expect(() => store.import(Buffer.from(uncheckedCaseRows([fresh, next])))).toThrow('conflicts');
  expect(store.list()).toHaveLength(1); expect(store.get(local.id)).toEqual(local); expect(() => store.get(fresh.id)).toThrow();
  const gap = { ...local, revision: 5, parentRevision: 4 };
  expect(() => store.import(Buffer.from(uncheckedCaseFile(gap)))).toThrow('sequence'); expect(store.get(local.id).revision).toBe(1);
});
it('imports family rows in revision order and applies immutable capture checks within one file', () => {
  const { store } = setup(), base = evalFixture(), next = { ...base, revision: 2, parentRevision: 1, annotation: { ...annotation(), notes: 'second' } };
  const file = Buffer.from(uncheckedCaseRows([next, base])); store.import(file); store.import(file);
  expect(store.get(base.id).revision).toBe(2); expect(store.get(base.id, 1).capture).toEqual(base.capture);
  const third = { ...structuredClone(next), revision: 3, parentRevision: 2 }; third.capture.entry.model = 'foreign-model';
  expect(() => store.import(Buffer.from(uncheckedCaseRows([third])))).toThrow('conflicts'); expect(store.get(base.id).revision).toBe(2);
});
it('marks every imported case as portable, preserves prior origin claims and repeat imports stay idempotent', () => {
  const { store } = setup(), c = evalFixture(), bytes = Buffer.from(encodeCaseFile(c)); store.import(bytes);
  expect(store.get(c.id).provenance).toEqual({ source: 'portable-import', archiveId: c.capture.entry.id, importedFrom: sha256(bytes) });
  store.import(bytes); expect(store.list()).toHaveLength(1);
  const reexport = Buffer.from(store.export(c.id, 1, true)), { store: destination } = setup(); destination.import(reexport); destination.import(reexport);
  expect(destination.get(c.id).provenance).toEqual(store.get(c.id).provenance);
});
it('deduplicates transformation disclosures across worker/main redaction and import/export cycles', () => {
  const { store } = setup(), c = evalFixture(); store.import(Buffer.from(encodeCaseFile(c)));
  const first = decodeCaseFile(Buffer.from(store.export(c.id, 1, true))).cases[0]!;
  let value = redactExport(first, true); for (let n = 0; n < 5; n++) value = redactExport(value, true);
  expect(value.missingContext).toEqual(first.missingContext);
  const { store: destination } = setup(); destination.import(Buffer.from(encodeCaseFile(value)));
  const again = decodeCaseFile(Buffer.from(destination.export(c.id, 1, true))).cases[0]!;
  expect(again.missingContext).toEqual(first.missingContext);
});
it('exports omit bodies by default, redact credential patterns and rehash changed protocol content', () => {
  const { store } = setup(), c = evalFixture();
  c.annotation.notes = 'api_key=should-not-export Bearer abcdef123456 sk-exampleSecret123456';
  c.capture.payload.data!.request = '{"password":"secretValue123","messages":[]}'; c.capture.payload.sha256 = sha256(JSON.stringify(c.capture.payload.data));
  store.import(Buffer.from(encodeCaseFile(c)));
  const omitted = store.export(c.id, 1, false); expect(decodeCaseFile(Buffer.from(omitted)).cases[0]!.capture.payload.state).toBe('omitted');
  const raw = store.export(c.id, 1, true); expect(raw).not.toContain('secretValue123'); expect(raw).not.toContain('should-not-export'); expect(raw).not.toContain('abcdef123456'); expect(raw).not.toContain('sk-exampleSecret123456');
  expect(decodeCaseFile(Buffer.from(raw)).cases[0]!.capture.payload.state).toBe('included');
});
it('native file reader rejects directories and malformed files without committing', async () => {
  const { store, dir } = setup();
  await expect(store.importFile(dir)).rejects.toThrow();
  const file = path.join(dir, 'bad.jsonl'); writeFileSync(file, '{}\n');
  await expect(store.importFile(file)).rejects.toThrow(); expect(store.list()).toEqual([]);
});
it('enforces actual per-family bytes and bounds record enumeration/file size before mutation', () => {
  const { store } = setup(), c = evalFixture(); c.capture.payload.data!.response = 'a'.repeat(3 * 1024 * 1024); c.capture.payload.sha256 = sha256(JSON.stringify(c.capture.payload.data));
  store.import(Buffer.from(encodeCaseFile(c))); store.revise(randomUUID(), c.id, 1, annotation());
  expect(() => store.revise(randomUUID(), c.id, 2, annotation())).toThrow('storage limit'); expect(store.get(c.id).revision).toBe(2);
  expect(() => decodeCaseFile(Buffer.from('{}\n'.repeat(1000)))).toThrow('count');
  expect(() => decodeCaseFile(Buffer.alloc(EVAL_LIMITS.fileBytes + 1))).toThrow('size');
});
it('enforces 200 pinned identities without eviction and explicit deletion frees capacity', () => {
  const { store } = setup();
  const first = store.create(randomUUID(), 'trace-synthetic-001', annotation(), false);
  for (let n = 1; n < EVAL_LIMITS.cases; n++) store.create(randomUUID(), 'trace-synthetic-001', annotation(), false);
  expect(() => store.create(randomUUID(), 'trace-synthetic-001', annotation(), false)).toThrow('storage limit'); expect(store.get(first.id)).toEqual(first);
  store.delete(first.id); store.create(randomUUID(), 'trace-synthetic-001', annotation(), false); expect(store.list()).toHaveLength(200);
});

const viWait = (fn: () => boolean) => vi.waitFor(() => expect(fn()).toBe(true));
