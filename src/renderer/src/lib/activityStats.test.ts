import { describe, expect, it } from 'vitest';
import { emptyCounts } from '@shared/activityCounts';
import type { ActivityBucket } from '@shared/types';
import { bucketStarts, byAccount, byModel, heatGrid, series, summarize } from './activityStats';

// Local-clock times so bucket edges don't depend on the test machine's zone.
const NOW = new Date(2026, 9, 26, 14, 30).getTime();
const at = (daysAgo: number, hour: number) => new Date(2026, 9, 26 - daysAgo, hour).getTime();
const row = (start: number, patch: Partial<ActivityBucket> = {}): ActivityBucket => ({
  ...emptyCounts(), start, wholeDay: false, provider: 'claude', authIndex: 'a', model: 'claude-opus-5-5', client: null, requests: 1, ...patch,
});

describe('bucketStarts', () => {
  it('ends with the bucket holding now, aligned to the local clock', () => {
    expect(bucketStarts('24h', NOW).at(-1)).toBe(at(0, 14));
    expect(bucketStarts('7d', NOW).at(-1)).toBe(at(0, 12));
    expect(bucketStarts('30d', NOW)).toHaveLength(30);
    expect(bucketStarts('30d', NOW)[0]).toBe(at(29, 0));
  });
});

describe('series / summarize', () => {
  it('puts each row in its bucket and drops rows before the range', () => {
    const starts = bucketStarts('24h', NOW);
    const points = series([row(at(0, 13)), row(at(0, 13)), row(at(0, 14)), row(at(3, 9))], starts, NOW);
    expect(points.at(-2)!.summary.requests).toBe(2);
    expect(points.at(-1)!.summary.requests).toBe(1);
    expect(points.reduce((n, p) => n + p.summary.requests, 0)).toBe(3);
  });
  it('rates cache hits over all prompt tokens, by each provider\'s rules', () => {
    const s = summarize([
      row(NOW, { inputTokens: 10, cachedTokens: 80, cacheWriteTokens: 10 }),
      row(NOW, { provider: 'codex', model: 'gpt-6.1-sol', inputTokens: 100, cachedTokens: 50 }),
    ]);
    expect(s.promptTokens).toBe(200);
    expect(s.cacheHitRate).toBeCloseTo(130 / 200);
  });
});

describe('byModel', () => {
  it('groups by provider and model, costliest first', () => {
    const models = byModel([row(NOW, { model: 'a', costUsd: 1 }), row(NOW, { model: 'b', costUsd: 3 }), row(NOW, { model: 'a', costUsd: 1 })]);
    expect(models.map((m) => [m.model, m.summary.requests])).toEqual([['b', 1], ['a', 2]]);
  });
});

describe('byAccount', () => {
  it('groups by account across models, costliest first, keeping requests without one', () => {
    const accounts = byAccount([
      row(NOW, { authIndex: 'a', model: 'x', costUsd: 1 }), row(NOW, { authIndex: 'b', costUsd: 5 }),
      row(NOW, { authIndex: 'a', model: 'y', costUsd: 1 }), row(NOW, { authIndex: null, costUsd: 0.5 }),
    ]);
    expect(accounts.map((a) => [a.authIndex, a.summary.requests])).toEqual([['b', 1], ['a', 2], [null, 1]]);
  });
});

describe('heatGrid', () => {
  it('shows the last 7 days oldest first, by local hour, without whole-day totals', () => {
    const grid = heatGrid([row(at(0, 9)), row(at(6, 23)), row(at(7, 9)), row(at(1, 0), { wholeDay: true })], 'week', NOW);
    expect(grid).toHaveLength(7);
    expect(grid[6]!.cells[9]!.requests).toBe(1);
    expect(grid[0]!.cells[23]!.requests).toBe(1);
    expect(grid.flatMap((r) => r.cells).reduce((n, c) => n + c.requests, 0)).toBe(2);
  });
  it('sums every week into its weekday for the rhythm view', () => {
    const grid = heatGrid([row(at(0, 9)), row(at(7, 9))], 'rhythm', NOW);
    // NOW is a Monday; rows run Monday first.
    expect(grid[0]!.cells[9]!.requests).toBe(2);
  });
});


describe('heatmap time frames', () => {
  const thursday = new Date(2026, 9, 29, 14, 30).getTime();
  const hour = (day: number, h = 12) => new Date(2026, 9, day, h).getTime();
  it('keeps all seven local days, including Friday through Sunday, in week and rhythm', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(hour(23 + i), { requests: i + 1 }));
    expect(heatGrid(rows, 'week', thursday).map((r) => r.cells[12]!.requests)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(heatGrid(rows, 'rhythm', thursday).map((r) => r.cells[12]!.requests)).toEqual([4, 5, 6, 7, 1, 2, 3]);
  });
  it('ends its single hourly row at the current hour across midnight', () => {
    const rows = [row(hour(28, 14)), row(hour(28, 15)), row(hour(29, 0)), row(hour(29, 14)), row(hour(29, 15))];
    const [grid] = heatGrid(rows, 'hourly', thursday);
    expect(grid!.hours).toEqual([...Array.from({ length: 9 }, (_, i) => 15 + i), ...Array.from({ length: 15 }, (_, i) => i)]);
    expect(grid!.cells.map((c) => c.requests).reduce((a, b) => a + b, 0)).toBe(3);
    expect(grid!.cells[0]!.requests).toBe(1);
    expect(grid!.cells[23]!.requests).toBe(1);
  });
  it('selects the previous full Monday-Sunday week even on Monday or Sunday', () => {
    const rows = Array.from({ length: 16 }, (_, i) => row(hour(18 + i)));
    for (const today of [26, 29, 31]) {
      const grid = heatGrid(rows, 'lastWeek', hour(today));
      expect(grid.map((r) => r.cells[12]!.requests)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(grid.map((r) => r.label)).toEqual(Array.from({ length: 7 }, (_, i) => new Date(hour(19 + i)).toLocaleDateString(undefined, { weekday: 'short' })));
    }
    const grid = heatGrid([row(hour(18)), row(hour(19)), row(hour(25)), row(hour(26))], 'lastWeek', thursday);
    expect(grid.map((r) => r.cells[12]!.requests)).toEqual([1, 0, 0, 0, 0, 0, 1]);
  });
  it('never assigns retained daily totals to a made-up hour', () => {
    const rows = [row(hour(23), { wholeDay: true, requests: 100 }), row(hour(25, 22))];
    for (const mode of ['week', 'rhythm', 'lastWeek'] as const) {
      expect(heatGrid(rows, mode, thursday).flatMap((r) => r.cells).reduce((n, c) => n + c.requests, 0)).toBe(1);
    }
  });
});
