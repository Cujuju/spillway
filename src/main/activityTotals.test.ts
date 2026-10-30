import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { addEvent, emptyCounts, localDay } from '@shared/activityCounts';
import { EVERY_REQUEST, inScope } from '@shared/activityScope';
import type { ActivityEvent } from '@shared/types';
import { openActivityDb, totalKey } from './activityDb';
import { addToTotals, storedTotalKey } from './activityTotals';
import { rememberUsage } from './usageLedger';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-hourly-'));
const file = path.join(dir, 'activity.db');
const key = 'ab'.repeat(32);
vi.mock('./paths', () => ({ appPaths: { activityDb: file, legacyActivityDir: path.join(dir, 'legacy') } }));
vi.mock('./settingsStore', () => ({ getSecrets: () => ({ databaseKey: key }), getSettings: () => ({ activity: { retentionDays: 1 } }) }));
const { activityLog } = await import('./activityLog');
const now = new Date(2026, 10, 3, 12).getTime();
let sequence = 0;
const event = (at: string, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at, requestId: `r${sequence++}`, selectionId: null, upstreamId: null, source: 'proxy', provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 10, ttftMs: 1, inputTokens: 100, outputTokens: 20,
  cachedTokens: 10, cacheWriteTokens: 2, sessionId: null, movedFrom: null, userAgent: null, client: 'cli', ...patch,
});
beforeEach(() => {
  activityLog.clear();
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterAll(() => {
  vi.restoreAllMocks();
  activityLog.close();
  rmSync(dir, { recursive: true, force: true });
});

it('preserves every count and dimension through pruning, re-pruning and restart', () => {
  const events = [
    event('2026-11-01T10:05:00Z'), event('2026-11-01T10:15:00Z', { failed: true }),
    event('2026-11-01T11:05:00Z', { source: 'client-log', authIndex: null }),
    event('2026-11-01T11:15:00Z', { client: 'other' }),
    event('2026-11-01T11:25:00Z', { provider: 'codex', model: 'gpt-5', authIndex: 'b' }),
  ];
  activityLog.importBatch('client.jsonl', 'checkpoint', events);
  const expected = emptyCounts();
  for (const e of events) addEvent(expected, e);
  activityLog.prune();
  expect(activityLog.days()).toEqual([]);
  const rows = activityLog.buckets(10);
  expect(rows).toHaveLength(4);
  const actual = emptyCounts();
  for (const r of rows) for (const k of Object.keys(actual) as (keyof typeof actual)[]) actual[k] += r[k];
  expect(actual).toEqual(expected);
  expect(rows.every((r) => !r.wholeDay)).toBe(true);
  expect(rows.filter((r) => inScope({ ...EVERY_REQUEST, source: 'proxy' }, r)).reduce((n,r) => n+r.requests, 0)).toBe(4);
  activityLog.prune();
  activityLog.close();
  expect(activityLog.buckets(10)).toEqual(rows);
  expect(activityLog.checkpoint('client.jsonl')).toBe('checkpoint');
  activityLog.importBatch('client.jsonl', 'next', events);
  expect(activityLog.buckets(10)).toEqual(rows);
});

it('keeps both fall-back hours distinct after pruning', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  try {
    activityLog.append(event('2026-11-01T01:15:00-07:00'));
    activityLog.append(event('2026-11-01T01:15:00-08:00'));
    activityLog.prune();
    expect(activityLog.totalsList()).toEqual([expect.objectContaining({ day: '2026-11-01', requests: 2 })]);
    expect(activityLog.buckets(10).map((r) => [r.start, r.requests])).toEqual([
      [Date.parse('2026-11-01T01:00:00-07:00'), 1], [Date.parse('2026-11-01T01:00:00-08:00'), 1],
    ]);
  } finally { vi.unstubAllEnvs(); }
});

it('migrates daily baselines once and reconciles against the correct baseline on mixed days', () => {
  const old = event('2026-11-01T10:05:00Z', { source: 'client-log', upstreamId: 'old', authIndex: null });
  const total = { ...emptyCounts(), day: localDay(Date.parse(old.at)), provider: old.provider, authIndex: old.authIndex,
    model: old.model, client: old.client, source: old.source };
  addEvent(total, old);
  activityLog.close();
  const db = openActivityDb(file, key);
  db.exec('CREATE TABLE day_totals (key TEXT PRIMARY KEY, total TEXT NOT NULL)');
  db.prepare('INSERT INTO day_totals VALUES (?, ?)').run(totalKey(total), JSON.stringify(total));
  rememberUsage(db, old, 0, null);
  db.close();
  expect(activityLog.buckets(10)).toEqual([expect.objectContaining({ wholeDay: true, requests: 1 })]);
  const newer = event('2026-11-01T10:15:00Z', { source: 'client-log', authIndex: null });
  activityLog.append(newer);
  expect(activityLog.buckets(10).reduce((n,r) => n+r.requests, 0)).toBe(2);
  expect(activityLog.totalsList()[0]?.requests).toBe(2);
  activityLog.close();
  expect(activityLog.buckets(10).reduce((n,r) => n+r.requests, 0)).toBe(2);
  activityLog.append(event(old.at, { upstreamId: 'old' }));
  const rows = activityLog.buckets(10);
  expect(rows.filter((r) => r.wholeDay).reduce((n,r) => n+r.requests, 0)).toBe(0);
  expect(rows.filter((r) => r.source === 'client-log').reduce((n,r) => n+r.requests, 0)).toBe(1);
  expect(rows.reduce((n,r) => n+r.requests, 0)).toBe(2);
  activityLog.prune();
  expect(activityLog.totalsList().reduce((n,r) => n+r.requests, 0)).toBe(2);
});

it('seeds an unreconstructed request into its baseline even when its hour exists', () => {
  const old = event('2026-11-01T10:05:00Z', { source: 'client-log', upstreamId: 'baseline-seed', authIndex: null });
  activityLog.close();
  const db = openActivityDb(file, key);
  db.exec("DELETE FROM meta WHERE key = 'usage-ledger-seeded'");
  const total = { ...emptyCounts(), day: localDay(Date.parse(old.at)), provider: old.provider, authIndex: old.authIndex,
    model: old.model, client: old.client, source: old.source };
  addEvent(total, old);
  addEvent(total, old); // One request was already pruned, so the day cannot be rebuilt.
  db.prepare('INSERT INTO activity_totals VALUES (?, ?)').run(totalKey(total), JSON.stringify(total));
  const hours = new Map();
  const hour = addToTotals(hours, old);
  db.prepare('INSERT INTO activity_totals VALUES (?, ?)').run(storedTotalKey(hour), JSON.stringify(hour));
  db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, 0, ?)').run(total.day, JSON.stringify(old));
  db.close();
  activityLog.append(event(old.at, { upstreamId: old.upstreamId }));
  const rows = activityLog.buckets(10);
  expect(rows.find((r) => r.wholeDay)?.requests).toBe(1);
  expect(rows.find((r) => !r.wholeDay && r.source === 'client-log')?.requests).toBe(1);
});

it('removes the recorded cost when reconciling a rebuilt client-log request', () => {
  const old = event('2026-11-01T10:05:00Z', { source: 'client-log', upstreamId: 'repriced', authIndex: null });
  activityLog.close();
  const db = openActivityDb(file, key);
  const total = { ...emptyCounts(), day: localDay(Date.parse(old.at)), provider: old.provider, authIndex: old.authIndex,
    model: old.model, client: old.client, source: old.source };
  addEvent(total, old);
  total.costUsd *= 2;
  total.uncachedCostUsd *= 2;
  db.prepare('INSERT INTO activity_totals VALUES (?, ?)').run(totalKey(total), JSON.stringify(total));
  const id = Number(db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, 0, ?)').run(total.day, JSON.stringify(old)).lastInsertRowid);
  rememberUsage(db, old, id, null);
  db.exec("DELETE FROM meta WHERE key = 'retained-hours-rebuilt'");
  db.close();
  expect(activityLog.buckets(10).find((r) => r.source === 'client-log')?.costUsd).toBe(total.costUsd);
  activityLog.append(event(old.at, { upstreamId: old.upstreamId }));
  expect(activityLog.buckets(10).find((r) => r.source === 'client-log')).toMatchObject({ requests: 0, costUsd: 0, uncachedCostUsd: 0 });
});

it('aggregates spring-forward hours by local calendar day', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  try {
    activityLog.append(event('2026-03-08T01:15:00-08:00'));
    activityLog.append(event('2026-03-08T03:15:00-07:00'));
    activityLog.append(event('2026-03-08T23:15:00-07:00'));
    expect(activityLog.totalsList()).toEqual([expect.objectContaining({ day: '2026-03-08', requests: 3 })]);
  } finally { vi.unstubAllEnvs(); }
});
