import { describe, expect, it } from 'vitest';
import { emptyCounts } from '@shared/activityCounts';
import type { ActivityBucket } from '@shared/types';
import { calendarWeeks, heatShape, hourOfDay, hourRows } from './activityHeat';
import { rangeSpan } from './activityRange';
import { moonPath, moonPhase, phaseName, skyBody, SUNRISE_HOUR, SUNSET_HOUR } from './sky';

// Thursday Oct 29 2026, 14:30 local.
const NOW = new Date(2026, 9, 29, 14, 30).getTime();
const hour = (d: number, h = 12) => new Date(2026, 9, d, h).getTime();
const row = (start: number, patch: Partial<ActivityBucket> = {}): ActivityBucket => ({
  ...emptyCounts(), start, wholeDay: false, provider: 'claude', authIndex: 'a', model: 'claude-opus-5-5', client: null, requests: 1, ...patch,
});
const span = (r: '24h' | '7d' | '90d') => rangeSpan(r, NOW, { from: '', to: '' }, null);
const sum = (cells: { requests: number }[]) => cells.reduce((n, c) => n + c.requests, 0);

describe('heatmap', () => {
  it('picks the shape from the span', () => {
    expect(heatShape(span('24h'))).toBe('hours');
    expect(heatShape(span('7d'))).toBe('days');
    expect(heatShape(span('90d'))).toBe('calendar');
    expect(heatShape(rangeSpan('custom', NOW, { from: '2026-10-28', to: '2026-10-29' }, null))).toBe('days');
    expect(heatShape(rangeSpan('all', NOW, { from: '', to: '' }, null))).toBe('hours');
    expect(heatShape(rangeSpan('custom', NOW, { from: '2026-10-16', to: '2026-10-29' }, null))).toBe('days');
    expect(heatShape(rangeSpan('custom', NOW, { from: '2026-10-15', to: '2026-10-29' }, null))).toBe('calendar');
  });

  it('shows the last 24 hours as one row ending at the current hour', () => {
    const [only] = hourRows([row(hour(28, 15)), row(hour(29, 0)), row(hour(29, 14)), row(hour(28, 14))], span('24h'));
    expect(only!.hours.at(-1)).toBe(14);
    expect(only!.cells).toHaveLength(24);
    expect(sum(only!.cells)).toBe(3);
  });

  it('shows one row per day for 7 days, leaving out daily totals', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(hour(23 + i), { requests: i + 1 }));
    const grid = hourRows([...rows, row(hour(25, 0), { wholeDay: true, requests: 100 })], span('7d'));
    expect(grid.map((r) => r.cells[12]!.requests)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('lays a calendar out in Monday-first weeks, counting daily totals, blank outside the span', () => {
    const weeks = calendarWeeks([row(hour(29)), row(hour(26, 0), { wholeDay: true, requests: 5 })], span('90d'));
    const last = weeks.at(-1)!;
    expect(new Date(last.start).getDay()).toBe(1);
    expect(last.days.map((d) => d?.requests ?? null)).toEqual([5, 0, 0, 1, null, null, null]);
    expect(weeks[0]!.days.some((d) => d === null)).toBe(true);
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
  it('puts the sun up between sunrise and sunset, highest at midday', () => {
    expect(skyBody(SUNRISE_HOUR).body).toBe('sun');
    expect(skyBody(SUNSET_HOUR).body).toBe('moon');
    expect(skyBody((SUNRISE_HOUR + SUNSET_HOUR) / 2).height).toBeCloseTo(1);
    expect(skyBody(0).height).toBeCloseTo(1);
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
