import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY } from '@shared/archive';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
import { diagnosticSnapshot } from './diagnosticSnapshot';
import { parseActivityEvent } from './sse';

const dirs: string[] = [], dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-diagnostic-')); dirs.push(dir);
  const db = openActivityDb(path.join(dir, 'activity.db'), 'ab'.repeat(32)); dbs.push(db);
  return { db, archive: new ArchiveStore(db) };
}
it('takes only selected full trace proxy attempts, preserves retry metadata, and never imports client-log bodies', () => {
  const { db, archive } = setup();
  const event = parseActivityEvent(JSON.stringify({ request_id: 'retry-1', trace_id: 'trace-selected', session_id: 'session-1', alias: 'model-alias', model: 'real-model', reasoning_effort: 'high' }))!;
  archive.observe(event);
  for (const e of [event, { ...event, requestId: 'retry-2' }, { ...event, requestId: 'client', source: 'client-log' }, { ...event, traceId: 'trace-unrelated', requestId: 'unrelated' }]) db.prepare('INSERT INTO requests(day,failed,event) VALUES(?,?,?)').run('2026-11-05', 0, JSON.stringify(e));
  const snapshot = diagnosticSnapshot(db, archive, 'trace-selected', false);
  expect(snapshot.attempts.map((e) => e.requestId)).toEqual(['retry-1', 'retry-2']);
  expect(snapshot.attempts[0]).toMatchObject({ effectiveModel: 'real-model', reasoningEffort: 'high' });
  expect(diagnosticSnapshot(db, archive, 'trace-unrelated', true).detail).toBeNull();
  expect(() => diagnosticSnapshot(db, archive, '../../auth.json', true)).toThrow('Invalid diagnostic trace');
});
it('preserves observed provenance after Activity expiry and keeps legacy links and absent identities unknown', () => {
  const { db, archive } = setup();
  archive.observe(parseActivityEvent('{"request_id":"lost-attempt","trace_id":"trace-selected"}')!);
  expect(diagnosticSnapshot(db, archive, 'trace-selected', false)).toMatchObject({ attempts: [{ requestId: 'lost-attempt', metadataSource: 'archive-link', model: null, failed: false }], attemptsUnavailable: 1 });
  const row = db.prepare('SELECT detail FROM archive_attempts WHERE trace_id=?').get('trace-selected') as { detail: string };
  const legacyLink = JSON.parse(row.detail) as { provenance?: unknown };
  delete legacyLink.provenance;
  db.prepare('UPDATE archive_attempts SET detail=? WHERE trace_id=?').run(JSON.stringify(legacyLink), 'trace-selected');
  expect(diagnosticSnapshot(db, archive, 'trace-selected', false)).toMatchObject({ attempts: [{ requestId: 'lost-attempt', metadataSource: 'unavailable', model: null, failed: null }], attemptsUnavailable: 1 });
  archive.clear();
  expect(diagnosticSnapshot(db, archive, 'trace-selected', true)).toEqual({ detail: null, attempts: [], attemptsOmitted: 0, attemptsUnavailable: 0 });
});
it('reports capture expiry at collection and permits retained bodies after capture opt-out without enabling capture', () => {
  const { db, archive } = setup(); archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: true });
  archive.ingest({ version: 1, epoch: 'epoch-a', dropped: 0, records: [{ id: 'capture-one', traceId: 'trace-selected', epoch: 'epoch-a', sequence: 1, startedAt: new Date().toISOString(), method: 'POST', path: '/v1/responses', status: 200, state: 'complete', reason: '', request: '{"input":"stored body"}', response: '', requestType: 'application/json', responseType: '', requestEncoding: '', responseEncoding: '', requestDecoded: true }] });
  archive.setPolicy({ ...DEFAULT_ARCHIVE_POLICY, captureBodies: false });
  expect(diagnosticSnapshot(db, archive, 'trace-selected', false).detail?.request).toBe('');
  expect(diagnosticSnapshot(db, archive, 'trace-selected', true).detail?.request).toContain('stored body');
  archive.prune(Date.now() + 8 * 86_400_000, true);
  expect(diagnosticSnapshot(db, archive, 'trace-selected', true).detail).toMatchObject({ state: 'expired', request: '', bytes: 0 });
  expect(archive.status().policy.captureBodies).toBe(false);
});
it('bounds attempts and reports the omitted count', () => {
  const { db, archive } = setup(); archive.observe(parseActivityEvent('{"trace_id":"trace-selected","request_id":"one"}')!);
  const insert = db.prepare('INSERT INTO requests(day,failed,event) VALUES(?,?,?)');
  db.transaction(() => { for (let i = 0; i < 203; i++) insert.run('2026-11-05', 0, JSON.stringify({ traceId: 'trace-selected', requestId: String(i), source: 'proxy' })); })();
  const result = diagnosticSnapshot(db, archive, 'trace-selected', false);
  expect(result.attempts).toHaveLength(200); expect(result.attemptsOmitted).toBe(4); expect(result.attemptsUnavailable).toBe(1);
});
it('uses independent allowlisted nested provenance after Activity expiry without guessing account identity', () => {
  const { db, archive } = setup(); archive.observe(parseActivityEvent('{"request_id":"lost-attempt","trace_id":"trace-selected"}')!);
  const detail = { requestId: 'lost-attempt', selectionId: null, at: '2026-11-05T00:00:00Z', provenance: { source: 'proxy', model: 'alias', effectiveModel: 'effective', reasoningEffort: 'medium', parentSessionId: 'parent', upstreamTransport: 'websocket', failed: null, authIndex: 'must-not-trust-extra-field', error: 'must-not-trust-extra-error' } };
  db.prepare('UPDATE archive_attempts SET detail=? WHERE trace_id=?').run(JSON.stringify(detail), 'trace-selected');
  const result = diagnosticSnapshot(db, archive, 'trace-selected', false);
  expect(result.attempts[0]).toMatchObject({ metadataSource: 'archive-link', model: 'alias', effectiveModel: 'effective', reasoningEffort: 'medium', parentSessionId: 'parent', upstreamTransport: 'websocket', failed: null });
  expect(result.attempts[0]).not.toHaveProperty('authIndex'); expect(result.attempts[0]).not.toHaveProperty('error'); expect(result.attemptsUnavailable).toBe(1);
  detail.provenance.source = 'client-log';
  db.prepare('UPDATE archive_attempts SET detail=? WHERE trace_id=?').run(JSON.stringify(detail), 'trace-selected');
  expect(diagnosticSnapshot(db, archive, 'trace-selected', false).attempts[0]).toMatchObject({ metadataSource: 'unavailable', model: null, failed: null });
});
it('uses the trace index and does not count beyond-page Activity rows as unavailable or omitted twice', () => {
  const { db, archive } = setup();
  const insert = db.prepare('INSERT INTO requests(day,failed,event) VALUES(?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 250; i++) {
      const event = parseActivityEvent(JSON.stringify({ trace_id: 'trace-selected', request_id: `request-${i}`, at: new Date(1_000_000 + i).toISOString() }))!;
      insert.run('2026-11-05', 0, JSON.stringify(event));
      if (i >= 50) archive.observe(event);
    }
  })();
  const result = diagnosticSnapshot(db, archive, 'trace-selected', false);
  expect(result.attempts).toHaveLength(200); expect(result.attemptsOmitted).toBe(50); expect(result.attemptsUnavailable).toBe(0);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT event FROM requests WHERE json_extract(event,'$.traceId')=? AND coalesce(json_extract(event,'$.source'),'proxy')='proxy' ORDER BY id LIMIT 200").all('trace-selected');
  expect(JSON.stringify(plan)).toContain('USING INDEX requests_by_trace'); expect(JSON.stringify(plan)).not.toContain('SCAN requests');
});
