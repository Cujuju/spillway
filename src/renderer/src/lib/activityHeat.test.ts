import { describe, expect, it } from 'vitest';
import { emptyCounts } from '@shared/activityCounts';
import type { ActivityBucket } from '@shared/types';
import { hourOfDay, weekdayHours } from './activityHeat';
import { rangeSpan } from './activityRange';
import { dayWeight, moonPath, moonPhase, phaseName } from './sky';

// Thursday Oct 29 2026, 14:30 local.
const NOW = new Date(2026, 9, 29, 14, 30).getTime();
const hour = (d: number, h = 12) => new Date(2026, 9, d, h).getTime();
const row = (start: number, patch: Partial<ActivityBucket> = {}): ActivityBucket => ({
  ...emptyCounts(), start, wholeDay: false, provider: 'claude', authIndex: 'a', model: 'claude-opus-5-5', client: null, requests: 1, ...patch,
});
const span = (r: '24h' | '7d' | '90d') => rangeSpan(r, NOW, { from: '', to: '' }, null);
const sum = (cells: { requests: number }[]) => cells.reduce((n, c) => n + c.requests, 0);

describe('heatmap', () => {
  it('keeps 7 weekday rows of 24 hours for every time frame', () => {
    for (const r of ['24h', '7d', '90d'] as const) {
      const { days } = weekdayHours([], span(r));
      expect(days).toHaveLength(7);
      expect(days.every((d) => d.length === 24)).toBe(true);
    }
  });

  it('sums each weekday hour over the span, Monday first, leaving out daily totals', () => {
    // Oct 22 and 29 2026 are Thursdays; Oct 26 is a Monday.
    const rows = [row(hour(22, 9)), row(hour(29, 9)), row(hour(26, 23), { requests: 4 }), row(hour(25, 0), { wholeDay: true, requests: 100 })];
    const { days, undetailedDays } = weekdayHours(rows, span('90d'));
    expect(days[3]![9]!.requests).toBe(2);
    expect(days[0]![23]!.requests).toBe(4);
    expect(sum(days.flat())).toBe(6);
    expect(undetailedDays).toBe(1);
  });

  it('counts only rows inside the span', () => {
    const { days } = weekdayHours([row(hour(29, 9)), row(hour(20, 9))], span('7d'));
    expect(sum(days.flat())).toBe(1);
  });
});

describe('rhythm', () => {
  it('sums each clock hour over the span and finds the busiest', () => {
    const rows = [row(hour(27, 21)), row(hour(28, 21)), row(hour(29, 9)), row(hour(20, 21)), row(hour(28, 3), { wholeDay: true })];
    const stats = hourOfDay(rows, span('7d'), 'requests');
    expect(stats.hours[21]!.requests).toBe(2);
    expect(stats.peak).toBe(21);
    expect(stats.total.requests).toBe(3);
    expect(stats.undetailedDays).toBe(1);
  });

  it('has no peak without data', () => {
    expect(hourOfDay([], span('7d'), 'cost')).toMatchObject({ peak: null, max: 0 });
  });
});

describe('sky', () => {
  it('weights bars by daylight: night 0, day 1, half at sunrise and sunset, across midnight too', () => {
    const times = { sunrise: 7, sunset: 18 };
    expect(dayWeight(2, times)).toBe(0);
    expect(dayWeight(12, times)).toBe(1);
    expect(dayWeight(7, times)).toBeCloseTo(0.5);
    expect(dayWeight(18, times)).toBeCloseTo(0.5);
    expect(dayWeight(1, { sunrise: 20, sunset: 4 })).toBe(1);
    expect(dayWeight(12, { sunrise: 0, sunset: 24 })).toBe(1);
    expect(dayWeight(12, { sunrise: 12, sunset: 12 })).toBe(0);
  });

  it('counts phase from the reference new moon over a mean synodic month', () => {
    const newMoon = Date.UTC(2000, 0, 6, 18, 14);
    const synodicMs = 29.530588853 * 24 * 60 * 60 * 1000;
    expect(phaseName(moonPhase(newMoon + 100 * synodicMs))).toBe('New moon');
    expect(phaseName(moonPhase(newMoon + 100.5 * synodicMs))).toBe('Full moon');
    expect(phaseName(moonPhase(newMoon + 100.25 * synodicMs))).toBe('First quarter');
  });

  it('lights the right limb while waxing and the left while waning', () => {
    expect(moonPath(0.3, 6)).toContain('0 0 1 0 6');
    expect(moonPath(0.7, 6)).toContain('0 0 0 0 6');
  });
});
