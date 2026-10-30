import { describe, expect, it, vi } from 'vitest';
import { emptyCounts } from '@shared/activityCounts';
import type { ActivityBucket } from '@shared/types';
import { heatGrid, hourlySeries, metricValue } from './activityStats';

const HOUR_MS = 60 * 60 * 1000;
const row = (start: number, patch: Partial<ActivityBucket> = {}): ActivityBucket => ({
  ...emptyCounts(), start, wholeDay: false, provider: 'claude', authIndex: 'a', model: 'test', client: null, requests: 1, ...patch,
});

describe('hourly activity contract', () => {
  it('shares the grid window, excludes daily/future rows, and supports every tile metric', () => {
    const currentHour = new Date(2026, 9, 29, 0).getTime();
    const now = currentHour + HOUR_MS / 2;
    const first = currentHour - 23 * HOUR_MS;
    const rows = [row(first - HOUR_MS), row(first),
      row(currentHour, { costUsd: 2, inputTokens: 10, cachedTokens: 20, outputTokens: 5 }),
      row(currentHour, { wholeDay: true, requests: 100 }), row(now + 1)];
    const points = hourlySeries(rows, now);
    expect(points).toHaveLength(24);
    expect(points[0]!.start).toBe(first);
    expect(points.at(-1)).toMatchObject({ start: currentHour, end: now });
    expect(points.reduce((sum, p) => sum + p.summary.requests, 0)).toBe(2);
    const metrics = ['cost', 'tokens', 'requests'] as const;
    expect(metrics.map((metric) => metricValue(points.at(-1)!.summary, metric))).toEqual([2, 35, 1]);
    expect(heatGrid(rows, 'hourly', now)[0]!.cells).toEqual(points.map((p) => p.summary));
    expect(hourlySeries([], now).every((p) => p.summary.requests === 0)).toBe(true);
  });

  it('preserves both fall-back hours, ending at the second occurrence of the current hour', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const first = Date.parse('2026-11-01T01:00:00-07:00');
      const second = Date.parse('2026-11-01T01:00:00-08:00');
      const points = hourlySeries([row(first), row(second, { requests: 2 })], second + HOUR_MS / 2);
      expect(new Date(first).getHours()).toBe(1);
      expect(new Date(second).getHours()).toBe(1);
      expect(points).toHaveLength(24);
      expect(points.at(-2)).toMatchObject({ start: first, summary: { requests: 1 } });
      expect(points.at(-1)).toMatchObject({ start: second, summary: { requests: 2 } });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
