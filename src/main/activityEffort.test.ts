import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it } from 'vitest';
import { addCounts, emptyCounts, localDay } from '@shared/activityCounts';
import { EVERY_REQUEST, inScope } from '@shared/activityScope';
import type { ActivityEvent } from '@shared/types';
import { ActivityLog } from './activityStore';
import { openActivityDb } from './activityDb';
import { storedTotalKey, totalKey } from './activityTotals';
import { parseActivityEvent } from './sse';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-effort-'));
const key = 'ab'.repeat(32);
let sequence = 0;
const logs: ActivityLog[] = [];
const createLog = () => {
  const config = { activityDb: path.join(dir, `${sequence++}.db`), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: key, retentionDays: 30 };
  const log = new ActivityLog(config);
  logs.push(log);
  return { log, config };
};
const event = (patch: Partial<ActivityEvent> = {}): ActivityEvent => ({ ...base(), ...patch });
function base(): ActivityEvent {
  return parseActivityEvent(JSON.stringify({ at: new Date().toISOString(), request_id: `r${sequence++}`, provider: 'claude',
    model: 'claude-opus-5-5', alias: 'coding', reasoning_effort: 'high', session_id: 'claude:session',
    latency_ms: 1000, ttft_ms: 200, input_tokens: 100, output_tokens: 20, cached_tokens: 10, cache_creation_tokens: 2 }))!;
}
const sum = (log: ActivityLog) => log.totalsList().reduce((c, t) => (addCounts(c, t), c), emptyCounts());
afterEach(() => { for (const log of logs.splice(0)) log.close(); });

it('persists effective effort and model separately and applies effort filters to pages, days and totals', () => {
  const { log } = createLog();
  const high = event({ parentSessionId: 'claude:parent' });
  log.append(high);
  log.append(event({ reasoningEffort: 'low' }));
  log.append(event({ reasoningEffort: null, effectiveModel: null }));
  log.close();
  const scope = { ...EVERY_REQUEST, efforts: ['high'] };
  const day = localDay(Date.parse(high.at));
  expect(log.page({ day: null, scope, before: null, failedOnly: false }).events).toMatchObject([
    { model: 'coding', effectiveModel: 'claude-opus-5-5', reasoningEffort: 'high', parentSessionId: 'claude:parent' },
  ]);
  expect(log.day(day, false, scope)).toHaveLength(1);
  expect(log.daySummaries(scope)[0]?.requests).toBe(1);
  expect(log.totalsList().filter((r) => inScope(scope, r))).toHaveLength(1);
  expect(log.page({ day: null, scope: { ...EVERY_REQUEST, efforts: [''] }, before: null, failedOnly: false }).events[0]?.reasoningEffort).toBeNull();
  expect(sum(log)).toMatchObject({ requests: 3, latencyCount: 3, ttftCount: 3, unpricedRequests: 1 });
});

it('reconciles pruned metadata-only imports into the effective effort bucket exactly once', () => {
  const { log } = createLog();
  const at = new Date(Date.now() - 40 * 86400_000).toISOString();
  const local = event({ at, source: 'client-log', requestId: 'local', upstreamId: 'response', reasoningEffort: null,
    effectiveModel: null, model: 'claude-opus-5-5', latencyMs: null, ttftMs: null });
  log.importEvents([{ ...local, costUsd: 7, uncachedCostUsd: 9 }]);
  log.close();
  const proxy = event({ at, upstreamId: 'response', latencyMs: 900, ttftMs: null });
  log.append(proxy);
  log.append(proxy);
  expect(sum(log)).toMatchObject({ requests: 1, latencyCount: 1, latencySumMs: 900, ttftCount: 0 });
  const unknown = log.totalsList().find((r) => r.source === 'client-log')!;
  expect(unknown).toMatchObject({ requests: 0, costUsd: 0, uncachedCostUsd: 0, latencyCount: 0 });
  expect(log.totalsList().find((r) => r.reasoningEffort === 'high')?.requests).toBe(1);
});

it('exports pruned accounting without inventing request timings and preserves costs and timing samples on replay', () => {
  const { log } = createLog();
  const at = new Date(Date.now() - 40 * 86400_000).toISOString();
  const e = event({ at });
  log.importEvents([{ ...e, costUsd: 7, uncachedCostUsd: 9 }]);
  log.close();
  const exported = [...log.exportEvents()];
  expect(exported[0]).toMatchObject({ reasoningEffort: 'high', effectiveModel: 'claude-opus-5-5', latencyCount: 1, latencySumMs: 1000 });
  expect(exported[0]?.latencyMs).toBeUndefined();
  const { log: target } = createLog();
  target.importEvents(exported);
  target.importEvents(exported);
  expect(sum(target)).toEqual(sum(log));
  expect(sum(target)).toMatchObject({ requests: 1, costUsd: 7, uncachedCostUsd: 9, latencyCount: 1, ttftCount: 1 });
});

it('keeps pre-analytics retained requests at zero accounted timing samples when exported', () => {
  const { log, config } = createLog();
  const original = event();
  log.append(original); log.close();
  const db = openActivityDb(config.activityDb, key);
  db.exec("UPDATE usage_identities SET event = json_remove(event, '$.latencyCount', '$.latencySumMs', '$.ttftCount', '$.ttftSumMs')");
  db.exec("UPDATE activity_totals SET total = json_remove(total, '$.latencyCount', '$.latencySumMs', '$.ttftCount', '$.ttftSumMs')");
  db.close();
  const exported = [...log.exportEvents()];
  expect(exported[0]).toMatchObject({ latencyMs: 1000, latencyCount: 0, ttftCount: 0 });
  const { log: target } = createLog();
  target.importEvents(exported);
  expect(sum(target)).toEqual(sum(log));
});

it('keeps legacy baseline keys, recorded cost and unknown timing intact beside new effort dimensions', () => {
  const { log, config } = createLog();
  log.totalsList(); log.close();
  const day = localDay(Date.now());
  const { latencyCount: _n, latencySumMs: _s, ttftCount: _tn, ttftSumMs: _ts, ...counts } = emptyCounts();
  const old = { ...counts, requests: 10, costUsd: 123, uncachedCostUsd: 150, day, provider: 'claude', model: 'coding', authIndex: null, client: null };
  const db = openActivityDb(config.activityDb, key);
  db.prepare('INSERT INTO activity_totals VALUES (?, ?)').run(totalKey(old), JSON.stringify(old));
  db.close();
  log.append(event()); log.close();
  const baseline = log.totalsList().find((r) => r.reasoningEffort == null)!;
  expect(storedTotalKey(baseline)).toBe(totalKey(old));
  expect(baseline).toMatchObject({ requests: 10, costUsd: 123, latencyCount: 0, ttftCount: 0 });
  expect(sum(log)).toMatchObject({ requests: 11, latencyCount: 1 });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
