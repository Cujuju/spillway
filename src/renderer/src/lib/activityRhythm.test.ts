import { describe, expect, it, vi } from 'vitest';
import { emptyCounts } from '@shared/activityCounts';
import type { ActivityBucket } from '@shared/types';
import { rhythmStats } from './activityStats';

const NOW = new Date(2026, 9, 29, 23, 59).getTime();
const row = (hour: number, patch: Partial<ActivityBucket> = {}): ActivityBucket => ({
  ...emptyCounts(), start: new Date(2026, 9, 29, hour).getTime(), wholeDay: false,
  provider: 'claude', authIndex: 'a', model: 'test', client: null, requests: 1, ...patch,
});

describe('time-of-day rhythm', () => {
  it('assigns the 0/6/12/18 boundaries and their preceding hours exactly once', () => {
    const result = rhythmStats([0, 5, 6, 11, 12, 17, 18, 23].map((h) => row(h, { requests: h + 1 })), 'requests', NOW);
    expect(result.bands.map((b) => b.summary.requests)).toEqual([19, 31, 43, 7]);
    expect(result.total.requests).toBe(100);
    expect(result.peak?.name).toBe('Evening');
  });
  it('selects the peak by metric and retains provider-aware token accounting', () => {
    const rows = [row(6, { costUsd: 10, inputTokens: 2, outputTokens: 3, requests: 5 }),
      row(12, { costUsd: 1, inputTokens: 20, cachedTokens: 30 }), row(18, { requests: 10 })];
    expect(rhythmStats(rows, 'cost', NOW).peak?.name).toBe('Morning');
    const tokens = rhythmStats(rows, 'tokens', NOW);
    expect(tokens.peak?.name).toBe('Afternoon');
    expect(tokens.total.totalTokens).toBe(55);
    expect(rhythmStats(rows, 'requests', NOW).peak?.name).toBe('Evening');
  });
  it('includes all stored hourly history, excludes daily and future rows, and reports its actual span', () => {
    const old = new Date(2026, 7, 1, 6).getTime();
    const stats = rhythmStats([row(6, { start: old }), row(6), row(0, { wholeDay: true, requests: 100 }), row(6, { start: NOW + 1 })], 'requests', NOW);
    expect(stats.total.requests).toBe(2);
    expect(stats.days).toBe(90);
  });
  it('has no peak for empty or zero-valued metrics, and breaks ties in display order', () => {
    expect(rhythmStats([], 'cost', NOW)).toMatchObject({ peak: null, max: 0, days: 0 });
    expect(rhythmStats([row(6)], 'cost', NOW).peak).toBeNull();
    expect(rhythmStats([row(6), row(12)], 'requests', NOW).peak?.name).toBe('Morning');
  });
  it('counts both repeated DST hours in Night and uses calendar days for the window', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const first = Date.parse('2026-11-01T01:00:00-07:00');
      const second = Date.parse('2026-11-01T01:00:00-08:00');
      expect(new Date(first).getHours()).toBe(1);
      expect(new Date(second).getHours()).toBe(1);
      expect(new Date(first).getTimezoneOffset()).not.toBe(new Date(second).getTimezoneOffset());
      const stats = rhythmStats([row(0, { start: first }), row(0, { start: second, requests: 2 })], 'requests', Date.parse('2026-11-02T00:30:00-08:00'));
      expect(stats.peak?.name).toBe('Night');
      expect(stats.bands[3]!.summary.requests).toBe(3);
      expect(stats.total.requests).toBe(3);
      expect(stats.days).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
