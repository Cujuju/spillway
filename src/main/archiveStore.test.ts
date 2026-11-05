import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY, type CaptureRecord } from '@shared/archive';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
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
  expect(store.detail('inbound-full-1')?.state).toBe('expired');
  expect(store.status().bytes).toBeLessThanOrEqual(1024 * 1024);
  expect(() => store.query({ text: '" OR * NOT (broken' })).not.toThrow();
  expect(store.query({ state: 'complete' }).entries).toHaveLength(2);
});
it('records sequence gaps/restarts and rolls back invalid pages before advancing the cursor', () => {
  const { store } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); observe(store);
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 3, records: [record(4)] });
  expect(store.status()).toMatchObject({ sequence: 4, gaps: 3, dropped: 3 });
  expect(() => store.ingest({ version: 1, epoch: 'epoch-a', dropped: 3, records: [record(5), record(6, { request: 'x'.repeat(800_000) })] })).toThrow();
  expect(store.status().sequence).toBe(4); expect(store.detail('inbound-full-5')).toBeNull();
  store.ingest({ version: 1, epoch: 'epoch-b', dropped: 0, records: [] });
  expect(store.status()).toMatchObject({ sequence: 0, restarts: 1 });
  expect(store.detail('inbound-full-1')?.reason).toBe('proxy-restarted-before-capture');
});
it('clears index and bodies and makes timed-out pending states explicit', () => {
  const { store } = setup(); store.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true }); observe(store);
  store.prune(Date.now() + 11 * 60_000);
  expect(store.detail('inbound-full-1')?.state).toBe('missing');
  store.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [record()] }); store.clear();
  expect(store.query({ text: 'needle' }).entries).toEqual([]); expect(store.status().entries).toBe(0);
});
