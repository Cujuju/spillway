import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_PAGE_SIZE, type ActivityDayTotal, type ActivityEvent } from '@shared/types';
import { EVERY_REQUEST } from '@shared/activityScope';

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
const { totalKey } = await import('./activityDb');
afterAll(() => {
  activityLog.close();
  rmSync(dir, { recursive: true, force: true });
});

const event = (at: Date, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at: at.toISOString(), requestId: `r-${at.getTime()}`, selectionId: null, upstreamId: null, source: 'proxy', provider: 'claude', model: 'opus', authIndex: 'a1',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 100, ttftMs: 10, inputTokens: 10, outputTokens: 5, cachedTokens: 1, cacheWriteTokens: 2, sessionId: null, movedFrom: null, userAgent: null, client: null,
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
  it('keeps repeated DST hours separate from event aggregation through both hourly charts', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const first = Date.parse('2026-11-01T01:00:00-07:00');
      const second = Date.parse('2026-11-01T01:00:00-08:00');
      const now = Date.parse('2026-11-01T01:30:00-08:00');
      expect(new Date(first).getTimezoneOffset()).toBe(420);
      expect(new Date(second).getTimezoneOffset()).toBe(480);
      const rows = hourlyBuckets([
        event(new Date('2026-11-01T01:15:00-07:00')),
        event(new Date('2026-11-01T01:15:00-08:00')),
        event(new Date('2026-11-01T01:25:00-08:00')),
      ]);
      expect(rows.map((r) => [r.start, r.requests])).toEqual([[first, 1], [second, 2]]);
      const { bucketStarts, heatGrid, series } = await import('../renderer/src/lib/activityStats');
      const [grid] = heatGrid(rows, 'hourly', now);
      expect(grid!.hours.slice(-2)).toEqual([1, 1]);
      expect(grid!.cells).toHaveLength(24);
      expect(grid!.cells.map((c) => c.requests)).toEqual([...Array<number>(22).fill(0), 1, 2]);
      const starts = bucketStarts('24h', now);
      expect(starts.slice(-2)).toEqual([first, second]);
      expect(series(rows, starts, now).map((p) => p.summary.requests)).toEqual(grid!.cells.map((c) => c.requests));
      // Rhythm intentionally combines both occurrences of the local hour.
      expect(heatGrid(rows, 'rhythm', now)[6]!.cells[1]!.requests).toBe(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('lists days oldest first, ending today', () => {
    expect(lastDays(new Date(2026, 9, 1, 12).getTime(), 3)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
  });
});

describe('activityLog', () => {
  beforeEach(() => activityLog.clear());

  it('returns every stored weekend hour to both heatmap views', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 29, 14, 30).getTime());
    try {
      const { heatGrid } = await import('../renderer/src/lib/activityStats');
      for (let day = 23; day <= 29; day++) activityLog.append(event(new Date(2026, 9, day, 12)));
      const rows = activityLog.buckets(31);
      expect(rows).toHaveLength(7);
      expect(rows.every((r) => !r.wholeDay)).toBe(true);
      for (const mode of ['week', 'rhythm'] as const) {
        expect(heatGrid(rows, mode, Date.now()).map((r) => r.cells[12]!.requests)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('pages every stored day newest first, without gaps or repeats', () => {
    const total = ACTIVITY_PAGE_SIZE + 3;
    for (let i = 0; i < total; i++) activityLog.append(event(daysAgo(i % 3, 1 + (i % 20)), { requestId: `r${i}` }));
    const first = activityLog.page({ day: null, failedOnly: false, scope: EVERY_REQUEST, before: null });
    expect(first.events).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(first.more).toBe(true);
    const second = activityLog.page({ day: null, failedOnly: false, scope: EVERY_REQUEST, before: first.events.at(-1)!.id });
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
    expect(activityLog.page({ day: null, failedOnly: true, scope: EVERY_REQUEST, before: null }).events.map((e) => e.requestId)).toEqual(['new-failed', 'old-failed']);
    const yesterday = localDay(daysAgo(1).getTime());
    expect(activityLog.page({ day: yesterday, failedOnly: false, scope: EVERY_REQUEST, before: null }).events.map((e) => e.requestId)).toEqual(['old-failed', 'old-ok']);
    expect(activityLog.day(yesterday).map((e) => e.requestId)).toEqual(['old-failed', 'old-ok']);
    expect(activityLog.day(yesterday, true).map((e) => e.requestId)).toEqual(['old-failed']);
    expect(summary(yesterday)).toMatchObject({ requests: 2, failed: 1, newestId: expect.any(Number), unpricedRequests: 0 });
    expect(summary(yesterday)!.costUsd).toBeGreaterThan(0);
    expect(activityLog.daySummaries().map((d) => d.day)).toEqual([localDay(Date.now()), yesterday]);
  });

  it('limits requests, day summaries and their cost to the chosen accounts', () => {
    const priced = { model: 'claude-opus-5-5' };
    activityLog.append(event(daysAgo(1), { requestId: 'a1-old', ...priced }));
    activityLog.append(event(daysAgo(0), { requestId: 'a2-new', authIndex: 'a2', failed: true, ...priced }));
    activityLog.append(event(daysAgo(0), { requestId: 'none-new', authIndex: null, ...priced }));
    const today = localDay(Date.now());
    const ids = (accounts: string[] | null) => activityLog.page({ day: null, failedOnly: false, scope: { accounts, clients: null }, before: null }).events.map((e) => e.requestId);
    expect(ids(['a2'])).toEqual(['a2-new']);
    expect(ids([''])).toEqual(['none-new']);
    expect(ids(['a1', ''])).toEqual(['none-new', 'a1-old']);
    expect(ids([])).toEqual([]);
    expect(activityLog.day(today, false, { accounts: ['a2'], clients: null }).map((e) => e.requestId)).toEqual(['a2-new']);
    const scoped = activityLog.daySummaries({ accounts: ['a2'], clients: null });
    expect(scoped.map((d) => [d.day, d.requests, d.failed])).toEqual([[today, 1, 1]]);
    expect(scoped[0]!.costUsd).toBeCloseTo(activityLog.totalsList().find((t) => t.authIndex === 'a2')!.costUsd);
    expect(activityLog.daySummaries().reduce((n, d) => n + d.requests, 0)).toBe(3);
  });

  it('limits requests, day summaries, totals and buckets to the chosen clients', () => {
    const priced = { model: 'claude-opus-5-5' };
    activityLog.append(event(daysAgo(0, 1), { requestId: 'cc', client: 'claude-cli', ...priced }));
    activityLog.append(event(daysAgo(0, 2), { requestId: 'sa', client: 'stockapp', failed: true, ...priced }));
    activityLog.append(event(daysAgo(0, 3), { requestId: 'none', ...priced }));
    const today = localDay(Date.now());
    const only = (clients: string[]) => ({ accounts: null, clients });
    const ids = (clients: string[]) => activityLog.page({ day: null, failedOnly: false, scope: only(clients), before: null }).events.map((e) => e.requestId);
    expect(ids(['stockapp'])).toEqual(['sa']);
    expect(ids([''])).toEqual(['none']);
    expect(ids(['claude-cli', ''])).toEqual(['none', 'cc']);
    expect(activityLog.page({ day: null, failedOnly: false, scope: { accounts: ['a2'], clients: ['stockapp'] }, before: null }).events).toEqual([]);
    expect(activityLog.day(today, false, only(['stockapp'])).map((e) => e.requestId)).toEqual(['sa']);
    expect(activityLog.daySummaries(only(['stockapp'])).map((d) => [d.day, d.requests, d.failed])).toEqual([[today, 1, 1]]);
    // Same day, account and model: one totals row per client.
    expect(activityLog.totalsList().map((t) => t.client).sort()).toEqual(['claude-cli', 'stockapp', null].sort());
    expect(activityLog.buckets(1).filter((b) => b.client === 'stockapp')).toHaveLength(1);
  });

  it('reads totals stored before clients were recorded as having none, under their old key', () => {
    activityLog.append(event(daysAgo(0), { requestId: 'before' }));
    const [stored] = activityLog.totalsList();
    expect(stored!.client).toBeNull();
    expect(totalKey(stored!)).toBe(`${stored!.day}|claude|a1|opus`);
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
    expect(activityLog.page({ day: "x' OR 1=1", failedOnly: false, scope: EVERY_REQUEST, before: null }).events).toEqual([]);
    expect(activityLog.page({ day: null, failedOnly: false, scope: EVERY_REQUEST, before: 1.5 }).events).toEqual([]);
  });

  it('keeps totals and requests across a reopen, encrypted on disk', () => {
    activityLog.append(event(daysAgo(0), { requestId: 'persisted-secret-id' }));
    activityLog.close();
    expect(readFileSync(dbFile).includes('persisted-secret-id')).toBe(false);
    expect(activityLog.page({ day: null, failedOnly: false, scope: EVERY_REQUEST, before: null }).events.map((e) => e.requestId)).toEqual(['persisted-secret-id']);
    expect(activityLog.totalsList()).toHaveLength(1);
  });

  it("marks a conversation's switch to another account, per model, across a reopen", () => {
    const at = daysAgo(0);
    let request = 0;
    const append = (authIndex: string, model = 'opus', sessionId: string | null = 'claude:s1') => activityLog.append(event(at, { requestId: `switch-${request++}`, authIndex, model, sessionId })).movedFrom;
    expect(append('a1')).toBeNull();
    expect(append('a1')).toBeNull();
    expect(append('a2', 'haiku')).toBeNull();
    expect(append('a2')).toBe('a1');
    expect(append('a1', 'opus', null)).toBeNull();
    activityLog.close();
    expect(append('a1')).toBe('a2');
    expect(activityLog.page({ day: null, failedOnly: false, scope: EVERY_REQUEST, before: null }).events[0]).toMatchObject({ sessionId: 'claude:s1', movedFrom: 'a2' });
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

    const page = activityLog.page({ day: null, failedOnly: false, scope: EVERY_REQUEST, before: null });
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


describe('client-log accounting', () => {
  beforeEach(() => activityLog.clear());
  it('reconciles either arrival order, including after retention and restart', () => {
    const at = daysAgo(40);
    const imported = event(at, { requestId: 'local', source: 'client-log', upstreamId: 'msg_merge', authIndex: null, sessionId: 'claude:s' });
    const proxy = event(at, { requestId: 'proxy', upstreamId: 'msg_merge', sessionId: 'claude:s' });
    activityLog.append(imported);
    activityLog.prune();
    activityLog.close();
    activityLog.append(proxy);
    activityLog.append(imported);
    expect(activityLog.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(1);
    expect(activityLog.totalsList().find((t) => t.source !== 'client-log')?.requests).toBe(1);
    activityLog.clear();
    activityLog.append(proxy);
    activityLog.append(imported);
    expect(activityLog.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(1);
  });
  it('filters requests, summaries, buckets and totals by source consistently', () => {
    activityLog.append(event(daysAgo(0), { requestId: 'proxy' }));
    activityLog.append(event(daysAgo(0), { requestId: 'direct', source: 'client-log', authIndex: null }));
    const scope = { accounts: null, clients: null, source: 'proxy' as const };
    expect(activityLog.daySummaries(scope)[0]?.requests).toBe(1);
    expect(activityLog.day(localDay(Date.now()), false, scope)).toHaveLength(1);
    expect(activityLog.page({ day: null, before: null, failedOnly: false, scope }).events).toHaveLength(1);
    expect(activityLog.buckets(1).filter((b) => b.source === 'proxy')[0]?.requests).toBe(1);
    expect(activityLog.totalsList().filter((b) => b.source === 'client-log')[0]?.requests).toBe(1);
  });
});


it('does not delete a newer request when SQLite reuses a pruned imported row id', () => {
  activityLog.clear();
  const old = event(daysAgo(40), { requestId: 'local-reused', source: 'client-log', upstreamId: 'msg_reused', authIndex: null });
  activityLog.append(old);
  activityLog.prune();
  activityLog.append(event(daysAgo(0), { requestId: 'new-proxy' }));
  activityLog.append(event(daysAgo(40), { requestId: 'old-proxy', upstreamId: 'msg_reused' }));
  expect(activityLog.day(localDay(Date.now())).map((e) => e.requestId)).toContain('new-proxy');
  expect(activityLog.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(2);
});
