import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_PAGE_SIZE, type ActivityDayTotal, type ActivityEvent } from '@shared/types';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-activity-'));
const dbFile = path.join(dir, 'activity.db');
const legacyDir = path.join(dir, 'activity');
const retention = { days: 30 };
const secrets = { databaseKey: 'ab'.repeat(32) };
vi.mock('./paths', () => ({ appPaths: { activityDb: dbFile, legacyActivityDir: legacyDir } }));
vi.mock('./settingsStore', () => ({
  getSettings: () => ({ activity: { retentionDays: retention.days } }),
  getSecrets: () => secrets,
}));

const { localDay } = await import('@shared/activityCounts');
const { activityLog, addToTotals, hourlyBuckets, lastDays, oldestKeptDay } = await import('./activityLog');
afterAll(() => {
  activityLog.close();
  rmSync(dir, { recursive: true, force: true });
});

const event = (at: Date, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at: at.toISOString(), requestId: `r-${at.getTime()}`, selectionId: null, provider: 'claude', model: 'opus', authIndex: 'a1',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 100, ttftMs: 10, inputTokens: 10, outputTokens: 5, cachedTokens: 1, cacheWriteTokens: 2,
  ...patch,
});
const storedCount = () => activityLog.daySummaries().reduce((n, d) => n + d.requests, 0);
const summary = (day: string) => activityLog.daySummaries().find((d) => d.day === day);
const daysAgo = (n: number, hour = 12) => {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() - n, hour);
};

describe('localDay / oldestKeptDay', () => {
  it('keys by local calendar day', () => {
    expect(localDay(new Date(2026, 9, 25, 23, 59).getTime())).toBe('2026-10-25');
  });
  it('keeps exactly the newest retention days, today included', () => {
    expect(oldestKeptDay(new Date(2026, 9, 25, 12).getTime(), 2)).toBe('2026-10-24');
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
  beforeEach(() => activityLog.clear());

  it('pages every stored day newest first, without gaps or repeats', () => {
    const total = ACTIVITY_PAGE_SIZE + 3;
    for (let i = 0; i < total; i++) activityLog.append(event(daysAgo(i % 3, 1 + (i % 20)), { requestId: `r${i}` }));
    const first = activityLog.page({ day: null, failedOnly: false, before: null });
    expect(first.events).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(first.more).toBe(true);
    const second = activityLog.page({ day: null, failedOnly: false, before: first.events.at(-1)!.id });
    expect(second.more).toBe(false);
    const ids = [...first.events, ...second.events].map((e) => e.requestId);
    expect(ids).toEqual(Array.from({ length: total }, (_, i) => `r${total - 1 - i}`));
    expect(storedCount()).toBe(total);
  });

  it('filters by day and failure in the query, and summarizes each day', () => {
    const priced = { model: 'claude-opus-5-5' };
    activityLog.append(event(daysAgo(1), { requestId: 'old-ok', ...priced }));
    activityLog.append(event(daysAgo(1), { requestId: 'old-failed', failed: true, ...priced }));
    activityLog.append(event(daysAgo(0), { requestId: 'new-failed', failed: true }));
    expect(activityLog.page({ day: null, failedOnly: true, before: null }).events.map((e) => e.requestId)).toEqual(['new-failed', 'old-failed']);
    const yesterday = localDay(daysAgo(1).getTime());
    expect(activityLog.page({ day: yesterday, failedOnly: false, before: null }).events.map((e) => e.requestId)).toEqual(['old-failed', 'old-ok']);
    expect(summary(yesterday)).toMatchObject({ requests: 2, failed: 1, newestId: expect.any(Number), unpricedRequests: 0 });
    expect(summary(yesterday)!.costUsd).toBeGreaterThan(0);
    expect(activityLog.daySummaries().map((d) => d.day)).toEqual([localDay(Date.now()), yesterday]);
  });

  it('prunes past retention and keeps the totals', () => {
    activityLog.append(event(daysAgo(40)));
    activityLog.append(event(daysAgo(0)));
    activityLog.prune();
    expect(activityLog.days()).toEqual([localDay(Date.now())]);
    expect(activityLog.totalsList().map((t) => t.day).sort()).toEqual([localDay(daysAgo(40).getTime()), localDay(Date.now())]);
  });

  it('serves stored days hourly and expired days from their totals', () => {
    retention.days = 2;
    activityLog.append(event(daysAgo(2)));
    activityLog.append(event(daysAgo(0)));
    activityLog.prune();
    retention.days = 30;
    const rows = activityLog.buckets(3);
    expect(rows.find((r) => r.wholeDay)).toMatchObject({ requests: 1, start: daysAgo(2).setHours(0, 0, 0, 0) });
    expect(rows.some((r) => !r.wholeDay)).toBe(true);
  });

  it('rejects malformed queries from the renderer', () => {
    activityLog.append(event(daysAgo(0)));
    expect(activityLog.day('../settings')).toEqual([]);
    expect(activityLog.page({ day: "x' OR 1=1", failedOnly: false, before: null }).events).toEqual([]);
    expect(activityLog.page({ day: null, failedOnly: false, before: 1.5 }).events).toEqual([]);
  });

  it('keeps totals and requests across a reopen, encrypted on disk', () => {
    activityLog.append(event(daysAgo(0), { requestId: 'persisted-secret-id' }));
    activityLog.close();
    expect(readFileSync(dbFile).includes('persisted-secret-id')).toBe(false);
    expect(activityLog.page({ day: null, failedOnly: false, before: null }).events.map((e) => e.requestId)).toEqual(['persisted-secret-id']);
    expect(activityLog.totalsList()).toHaveLength(1);
  });

  it('sets aside a database the key cannot read and starts empty', () => {
    activityLog.append(event(daysAgo(0)));
    activityLog.close();
    secrets.databaseKey = 'cd'.repeat(32);
    try {
      expect(storedCount()).toBe(0);
      expect(readdirSync(dir).some((f) => f.startsWith('activity.db.unreadable-'))).toBe(true);
    } finally {
      activityLog.close();
      secrets.databaseKey = 'ab'.repeat(32);
      for (const f of readdirSync(dir)) if (f.startsWith('activity.db')) rmSync(path.join(dir, f));
    }
  });
});

describe('legacy file import', () => {
  it('imports day files and totals once, in order, then deletes them', () => {
    activityLog.close();
    for (const f of readdirSync(dir)) if (f.startsWith('activity.db')) rmSync(path.join(dir, f));
    mkdirSync(legacyDir, { recursive: true });
    const { cacheWriteTokens: _, ...beforeCacheWrites } = event(new Date(2026, 0, 2, 9), { requestId: 'a' });
    writeFileSync(path.join(legacyDir, '2026-01-02.jsonl'), `${JSON.stringify(beforeCacheWrites)}\nnot json\n${JSON.stringify(event(new Date(2026, 0, 2, 10), { requestId: 'b' }))}\n`);
    writeFileSync(path.join(legacyDir, '2026-01-03.jsonl'), `${JSON.stringify(event(new Date(2026, 0, 3, 9), { requestId: 'c', failed: true }))}\n`);
    writeFileSync(path.join(legacyDir, 'daily-totals.json'), JSON.stringify([{ day: '2026-01-02', provider: 'claude', authIndex: 'a1', model: 'opus', requests: 2 }]));

    const page = activityLog.page({ day: null, failedOnly: false, before: null });
    expect(page.events.map((e) => e.requestId)).toEqual(['c', 'b', 'a']);
    expect(page.events.at(-1)?.cacheWriteTokens).toBe(0);
    expect(summary('2026-01-03')).toMatchObject({ requests: 1, failed: 1 });
    expect(activityLog.totalsList()).toEqual([expect.objectContaining({ day: '2026-01-02', requests: 2, costUsd: expect.any(Number) })]);
    expect(existsSync(legacyDir)).toBe(false);

    // Files an older version writes after the import are deleted without a second import.
    activityLog.close();
    mkdirSync(legacyDir);
    writeFileSync(path.join(legacyDir, '2026-01-04.jsonl'), `${JSON.stringify(event(new Date(2026, 0, 4, 9)))}\n`);
    expect(storedCount()).toBe(3);
    expect(existsSync(legacyDir)).toBe(false);
  });
});
