import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addEvent, emptyCounts, localDay, localHourStart } from '@shared/activityCounts';
import type { ActivityCounts, ActivityEvent } from '@shared/types';
import { openActivityDb, totalKey, type Db } from './activityDb';
import { rebuildRetainedTotals } from './activityMigration';
import { readTotals, storedTotalKey, type ActivityTotal } from './activityTotals';
import { rememberUsage } from './usageLedger';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-migration-'));
const key = 'cd'.repeat(32);
let db: Db;
let sequence = 0;
const event = (at: string, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at, requestId: `r${sequence++}`, selectionId: null, upstreamId: null, source: 'proxy', provider: 'claude', model: 'claude-opus-5-5',
  authIndex: 'a', stream: true, failed: false, statusCode: null, error: null, latencyMs: 10, ttftMs: 1, inputTokens: 100,
  outputTokens: 20, cachedTokens: 10, cacheWriteTokens: 2, sessionId: null, movedFrom: null, userAgent: null, client: 'cli', ...patch,
});
const store = (e: ActivityEvent) => {
  const id = Number(db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)')
    .run(localDay(Date.parse(e.at)), e.failed ? 1 : 0, JSON.stringify(e)).lastInsertRowid);
  rememberUsage(db, e, id, null);
};
/** A legacy whole-day baseline summing `events`. */
const baseline = (events: ActivityEvent[], adjust: (t: ActivityTotal) => void = () => {}) => {
  const [first] = events;
  const t: ActivityTotal = { ...emptyCounts(), day: localDay(Date.parse(first!.at)), provider: first!.provider,
    authIndex: first!.authIndex, model: first!.model, client: first!.client, source: first!.source };
  for (const e of events) addEvent(t, e);
  adjust(t);
  db.prepare('INSERT INTO activity_totals (key, total) VALUES (?, ?)').run(totalKey(t), JSON.stringify(t));
  return t;
};
const rows = () => [...readTotals(db).values()];
const sum = (ts: ActivityCounts[]) => ts.reduce((acc, t) => {
  for (const k of Object.keys(acc) as (keyof ActivityCounts)[]) acc[k] += t[k];
  return acc;
}, emptyCounts());

beforeEach(() => { db = openActivityDb(path.join(dir, `${sequence++}.db`), key); });
afterEach(() => { db.close(); vi.unstubAllEnvs(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('turns a fully retained day into hourly totals that sum to its baseline', () => {
  const events = [event('2026-10-20T09:05:00Z'), event('2026-10-20T09:40:00Z', { failed: true }), event('2026-10-20T15:10:00Z')];
  events.forEach(store);
  const old = baseline(events);
  rebuildRetainedTotals(db);
  const after = rows();
  expect(after.every((t) => t.start !== undefined)).toBe(true);
  expect(after).toHaveLength(2);
  expect(sum(after)).toEqual(sum([old]));
  const identity = db.prepare('SELECT event FROM usage_identities').all() as { event: string }[];
  expect(identity.map((r) => JSON.parse(r.event).totalStart)).toEqual(events.map((e) => localHourStart(Date.parse(e.at))));
});

it('keeps the cost recorded at the time instead of repricing', () => {
  const events = [event('2026-10-20T09:05:00Z'), event('2026-10-20T15:10:00Z', { inputTokens: 300 })];
  events.forEach(store);
  const old = baseline(events, (t) => { t.costUsd *= 2; t.uncachedCostUsd *= 2; });
  rebuildRetainedTotals(db);
  const total = sum(rows());
  expect(total.costUsd).toBeCloseTo(old.costUsd, 12);
  expect(total.uncachedCostUsd).toBeCloseTo(old.uncachedCostUsd, 12);
});

it('keeps baselines for pruned days and for days missing requests', () => {
  const pruned = baseline([event('2026-09-01T09:05:00Z')]);
  const kept = event('2026-10-20T09:05:00Z');
  store(kept);
  const partial = baseline([kept, event('2026-10-20T11:00:00Z')]);
  rebuildRetainedTotals(db);
  expect(rows().map(storedTotalKey).sort()).toEqual([storedTotalKey(pruned), storedTotalKey(partial)].sort());
});

it('merges a day holding both a baseline and newer hourly rows', () => {
  const early = event('2026-10-29T09:05:00Z');
  const late = event('2026-10-29T18:05:00Z');
  [early, late].forEach(store);
  baseline([early]);
  const hour: ActivityTotal = { ...emptyCounts(), day: localDay(Date.parse(late.at)), start: localHourStart(Date.parse(late.at)),
    provider: late.provider, authIndex: late.authIndex, model: late.model, client: late.client, source: late.source };
  addEvent(hour, late);
  db.prepare('INSERT INTO activity_totals (key, total) VALUES (?, ?)').run(storedTotalKey(hour), JSON.stringify(hour));
  rebuildRetainedTotals(db);
  expect(rows().every((t) => t.start !== undefined)).toBe(true);
  expect(sum(rows()).requests).toBe(2);
});

it('is idempotent', () => {
  const events = [event('2026-10-20T09:05:00Z'), event('2026-10-20T15:10:00Z')];
  events.forEach(store);
  baseline(events);
  rebuildRetainedTotals(db);
  const once = rows();
  rebuildRetainedTotals(db);
  expect(rows()).toEqual(once);
});

it('keeps both fall-back hours distinct', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  const events = [event('2026-11-01T01:15:00-07:00'), event('2026-11-01T01:15:00-08:00')];
  events.forEach(store);
  baseline(events);
  rebuildRetainedTotals(db);
  expect(rows().map((t) => [t.start, t.requests])).toEqual([
    [Date.parse('2026-11-01T01:00:00-07:00'), 1], [Date.parse('2026-11-01T01:00:00-08:00'), 1],
  ]);
});
