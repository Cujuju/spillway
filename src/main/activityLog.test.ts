import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ActivityDayTotal, ActivityEvent } from '@shared/types';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-activity-'));
const retention = { days: 30 };
vi.mock('./paths', () => ({ appPaths: { activityDir: dir } }));
vi.mock('./settingsStore', async () => {
  const fs = await import('node:fs');
  return {
    getSettings: () => ({ activity: { retentionDays: retention.days } }),
    writeFileAtomic: (file: string, data: string) => fs.writeFileSync(file, data),
  };
});

const { activityLog, addToTotals, expiredDays, hourlyBuckets, lastDays, localDay } = await import('./activityLog');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const event = (at: Date, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at: at.toISOString(), requestId: `r-${at.getTime()}`, selectionId: null, provider: 'claude', model: 'opus', authIndex: 'a1',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 100, ttftMs: 10, inputTokens: 10, outputTokens: 5, cachedTokens: 1, cacheWriteTokens: 2,
  ...patch,
});

describe('localDay / expiredDays', () => {
  it('keys by local calendar day', () => {
    expect(localDay(new Date(2026, 9, 25, 23, 59).getTime())).toBe('2026-10-25');
  });
  it('keeps exactly the newest retention days, today included', () => {
    const today = new Date(2026, 9, 25, 12).getTime();
    expect(expiredDays(['2026-10-23', '2026-10-24', '2026-10-25'], today, 2)).toEqual(['2026-10-23']);
  });
});

describe('addToTotals', () => {
  it('sums requests, failures and tokens per day, account and model', () => {
    const totals = new Map<string, ActivityDayTotal>();
    const day = new Date(2026, 9, 25, 9);
    addToTotals(totals, event(day));
    addToTotals(totals, event(day, { failed: true, inputTokens: 1 }));
    addToTotals(totals, event(day, { model: 'haiku' }));
    expect([...totals.values()].find((t) => t.model === 'opus')).toMatchObject({ day: '2026-10-25', requests: 2, failed: 1, inputTokens: 11, cacheWriteTokens: 4 });
    expect(totals.size).toBe(2);
  });
});

describe('hourlyBuckets / lastDays', () => {
  it('sums requests per local hour, account and model', () => {
    const rows = hourlyBuckets([event(new Date(2026, 9, 25, 9, 5)), event(new Date(2026, 9, 25, 9, 55)), event(new Date(2026, 9, 25, 10, 1))]);
    expect(rows.map((r) => [new Date(r.start).getHours(), r.requests])).toEqual([[9, 2], [10, 1]]);
  });
  it('lists days oldest first, ending today', () => {
    expect(lastDays(new Date(2026, 9, 1, 12).getTime(), 3)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
  });
});

describe('activityLog', () => {
  it('stores requests per day, lists days newest first, and prunes past retention', () => {
    const today = new Date();
    const old = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 40, 12);
    activityLog.append(event(old));
    activityLog.append(event(today));
    activityLog.flush();
    expect(activityLog.day(localDay(today.getTime())).map((e) => e.requestId)).toEqual([event(today).requestId]);
    activityLog.prune();
    expect(activityLog.days()).toEqual([localDay(today.getTime())]);
    // Totals outlive the pruned day.
    expect(activityLog.totalsList().map((t) => t.day).sort()).toEqual([localDay(old.getTime()), localDay(today.getTime())]);
    expect(JSON.parse(readFileSync(path.join(dir, 'daily-totals.json'), 'utf8'))).toHaveLength(2);
  });
  it('reads requests saved before cache writes were recorded as having none', () => {
    const { cacheWriteTokens: _, ...legacy } = event(new Date(2026, 0, 2, 12));
    appendFileSync(path.join(dir, '2026-01-02.jsonl'), `${JSON.stringify(legacy)}
`);
    expect(activityLog.day('2026-01-02')[0]?.cacheWriteTokens).toBe(0);
  });
  it('serves stored days hourly and expired days from their totals', () => {
    const today = new Date();
    const expired = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2, 12);
    activityLog.append(event(expired));
    activityLog.flush();
    rmSync(path.join(dir, `${localDay(expired.getTime())}.jsonl`));
    const rows = activityLog.buckets(3);
    expect(rows.find((r) => r.wholeDay)).toMatchObject({ requests: 1, start: new Date(expired).setHours(0, 0, 0, 0) });
    expect(rows.some((r) => !r.wholeDay)).toBe(true);
  });
  it('rejects day keys that are not dates', () => {
    expect(activityLog.day('../settings')).toEqual([]);
  });
});
