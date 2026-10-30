import { afterEach, describe, expect, it, vi } from 'vitest';
import { bucketStarts, bucketUnit, calendarDays, daysToFetch, floorTo, isCustomRange, rangeSpan, type Range } from './activityRange';

// Monday Oct 26 2026, 14:30 local.
const NOW = new Date(2026, 9, 26, 14, 30).getTime();
const day = (d: number, h = 0) => new Date(2026, 9, d, h).getTime();
const NO_CUSTOM = { from: '', to: '' };
const span = (r: Range) => rangeSpan(r, NOW, NO_CUSTOM, null);

describe('rangeSpan / bucketUnit / bucketStarts', () => {
  it('rejects invalid persisted dates and safely bounds invalid custom input', () => {
    for (const from of ['', 'garbage', '2026-02-30', '2026-13-01']) {
      const custom = { from, to: '2026-10-26' };
      expect(isCustomRange(custom)).toBe(false);
      expect(rangeSpan('custom', NOW, custom, null)).toEqual({ from: day(26), to: NOW });
    }
  });
  it.each([
    ['24h', 'hour', 24],
    ['7d', '3h', 53],
    ['30d', 'day', 30],
    ['90d', 'day', 90],
    ['1y', 'week', 53],
  ] as const)('%s uses %s buckets ending with the one holding now', (range, unit, count) => {
    const s = span(range);
    expect(bucketUnit(s)).toBe(unit);
    const starts = bucketStarts(s, unit);
    expect(starts).toHaveLength(count);
    expect(starts.at(-1)!).toBeLessThanOrEqual(NOW);
    expect(starts[0]!).toBeLessThanOrEqual(s.from);
  });

  it('starts day presets at local midnight, today included', () => {
    expect(span('7d').from).toBe(day(20));
    expect(span('30d').from).toBe(day(26 - 29));
  });

  it('aligns weeks to Monday and months to the 1st', () => {
    const year = span('1y');
    expect(new Date(bucketStarts(year, 'week')[0]!).getDay()).toBe(1);
    expect(bucketStarts({ from: day(5), to: NOW }, 'month')).toEqual([new Date(2026, 9, 1).getTime()]);
  });

  it('runs "All" from the earliest held day and uses months past two years', () => {
    const earliest = new Date(2023, 5, 3, 9).getTime();
    const all = rangeSpan('all', NOW, NO_CUSTOM, earliest);
    expect(all.from).toBe(new Date(2023, 5, 3).getTime());
    expect(bucketUnit(all)).toBe('month');
    expect(rangeSpan('all', NOW, NO_CUSTOM, null).from).toBe(day(26));
  });

  it('covers whole custom days, in either order, never past now', () => {
    const s = rangeSpan('custom', NOW, { from: '2026-10-28', to: '2026-10-10' }, null);
    expect(s.from).toBe(day(10));
    expect(s.to).toBe(NOW);
    expect(rangeSpan('custom', NOW, { from: '2026-10-10', to: '2026-10-12' }, null).to).toBe(day(13) - 1);
  });

  it('fetches every day the span touches, or everything for "All"', () => {
    expect(daysToFetch('7d', span('7d'), NOW)).toBe(7);
    expect(daysToFetch('24h', span('24h'), NOW)).toBe(2);
    expect(daysToFetch('all', span('all'), NOW)).toBeNull();
  });
});

describe('DST', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(['2026-03-08T12:00:00-07:00', '2026-11-01T12:00:00-08:00'])('matches local bucket boundaries across %s', (iso) => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const now = Date.parse(iso);
    const s = rangeSpan('7d', now, NO_CUSTOM, null);
    expect(calendarDays(s)).toBe(7);
    expect(daysToFetch('7d', s, now)).toBe(7);
    for (const unit of ['3h', 'day', 'week', 'month'] as const) {
      const starts = bucketStarts(s, unit);
      for (const hour of bucketStarts(s, 'hour')) expect(starts).toContain(floorTo(hour, unit));
    }
  });
  it('keeps both fall-back hours as separate 24h buckets', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const now = Date.parse('2026-11-01T01:30:00-08:00');
    const starts = bucketStarts(rangeSpan('24h', now, NO_CUSTOM, null), 'hour');
    expect(starts.slice(-2)).toEqual([Date.parse('2026-11-01T01:00:00-07:00'), Date.parse('2026-11-01T01:00:00-08:00')]);
    expect(starts).toHaveLength(24);
  });
});
