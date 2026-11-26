import { describe, expect, it } from 'vitest';
import type { Credential, LimitWindow } from '@shared/types';
import type { SeriesPoint } from './poolHistory';
import { appendLivePoint, decimateSeries, durationChoices, keyForDuration, nextResetAt, poolSegments, scopedChoices, valueAt } from './poolWindows';

const H = 3_600_000;
const win = (key: string, label: string, durationMs: number | null, scoped = false): LimitWindow =>
  ({ key, label, durationMs, scoped, usedPercent: 10, resetsAt: null, status: null, resetCadence: null }) as LimitWindow;
const cred = (windows: LimitWindow[]) => ({ windows }) as Credential;

const claude = [cred([win('five_hour', '5-hour', 5 * H), win('seven_day', 'Weekly', 168 * H), win('seven_day_fable', 'Weekly · Fable', 168 * H, true)])];
const codex = [cred([win('primary', '5-hour', 5 * H), win('secondary', 'Weekly', 168 * H)])];

describe('window choices', () => {
  it('groups several providers by account-wide length', () => {
    expect(durationChoices([claude, codex])).toEqual([{ value: String(5 * H), label: '5-hour' }, { value: String(168 * H), label: 'Weekly' }]);
  });
  it('lists a provider\'s scoped windows, shortest first, unknown length last', () => {
    const spend = cred([win('spend', 'Spend limit', null, true), win('five_hour', '5-hour', 5 * H)]);
    expect(scopedChoices([...claude, spend])).toEqual([{ value: 'seven_day_fable', label: 'Weekly · Fable' }, { value: 'spend', label: 'Spend limit' }]);
    expect(scopedChoices(codex)).toEqual([]);
  });
  it('finds each provider its own key for a length, skipping scoped windows', () => {
    expect(keyForDuration(claude, 168 * H)).toBe('seven_day');
    expect(keyForDuration(codex, 168 * H)).toBe('secondary');
    expect(keyForDuration(codex, 24 * H)).toBeNull();
  });
});

describe('card lines', () => {
  const NOW = Date.parse('2026-01-01T00:00:00Z');
  const at = (h: number) => new Date(NOW + h * H).toISOString();
  const acct = (id: string, used: number | null, resetsAt: string | null, status: LimitWindow['status'] = null) =>
    ({ id, windows: [{ ...win('seven_day', 'Weekly', 168 * H), usedPercent: used, resetsAt, status }] }) as Credential;
  const accounts = [acct('max', 84, at(5)), acct('pro', 27, at(2), 'rejected'), acct('new', null, null), acct('unshared', 10, at(1))];
  const shares = new Map([['max', { share: 5 / 6, cost: {} }], ['pro', { share: 1 / 6, cost: {} }], ['new', { share: 0, cost: {} }]]);

  it('gives each shared account with data one segment, sized by its share', () => {
    expect(poolSegments(accounts, 'seven_day', shares)).toEqual([
      { id: 'max', share: 5 / 6, usedPercent: 84, rejected: false },
      { id: 'pro', share: 1 / 6, usedPercent: 100, rejected: true },
    ]);
  });
  it('empties a session segment blocked by weekly quota without changing its share', () => {
    const c = acct('max', 100, at(5));
    c.windows.push({ ...win('five_hour', '5-hour', 5 * H), usedPercent: 0 });
    expect(poolSegments([c], 'five_hour', shares)).toEqual([
      { id: 'max', share: 5 / 6, usedPercent: 100, rejected: true },
    ]);
  });
  it('finds the soonest pending reset and ignores past ones', () => {
    expect(nextResetAt(accounts, 'seven_day', NOW)).toBe(NOW + H);
    expect(nextResetAt(accounts, 'seven_day', NOW + 6 * H)).toBeNull();
  });
});

describe('valueAt', () => {
  const pts = [{ t: 0, remaining: 100 }, { t: 10, remaining: 50 }, { t: 20, remaining: 50 }];
  it('interpolates between points and is exact on them', () => {
    expect(valueAt(pts, 5)).toBe(75);
    expect(valueAt(pts, 10)).toBe(50);
    expect(valueAt(pts, 0)).toBe(100);
  });
  it('is null outside the series', () => {
    expect(valueAt(pts, -1)).toBeNull();
    expect(valueAt(pts, 21)).toBeNull();
    expect(valueAt([], 0)).toBeNull();
  });

  it('returns the first exact match and interpolates from the last earlier duplicate', () => {
    const duplicates = [
      { t: 0, remaining: 5 }, { t: 0, remaining: 100 },
      { t: 10, remaining: 60 }, { t: 10, remaining: 50 },
      { t: 20, remaining: 10 }, { t: 20, remaining: 99 },
    ];
    expect(valueAt(duplicates, 0)).toBe(5);
    expect(valueAt(duplicates, 5)).toBe(80);
    expect(valueAt(duplicates, 10)).toBe(60);
    expect(valueAt(duplicates, 15)).toBe(30);
    expect(valueAt(duplicates, 20)).toBe(10);
    expect(valueAt(duplicates.slice(0, 1), 0)).toBe(5);
  });

  it('matches linear search on randomized series with exact hits and duplicates', () => {
    function linear(points: SeriesPoint[], t: number): number | null {
      if (!points.length || t < points[0]!.t || t > points.at(-1)!.t) return null;
      const i = points.findIndex((p) => p.t >= t);
      const b = points[i]!;
      if (i === 0 || b.t === t) return b.remaining;
      const a = points[i - 1]!;
      return a.remaining + ((b.remaining - a.remaining) * (t - a.t)) / (b.t - a.t);
    }
    let seed = 42;
    const random = () => {
      seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let length = 0; length <= 64; length++) {
      let t = -20;
      const points = Array.from({ length }, () => ({ t: t += Math.floor(random() * 4), remaining: random() * 100 }));
      for (const time of [-21, t + 1, ...points.flatMap((p) => [p.t, p.t + 0.5, -21 + random() * (t + 22)])]) {
        expect(valueAt(points, time)).toBe(linear(points, time));
      }
    }
  });
});

describe('decimateSeries', () => {
  const ramp = (count: number): SeriesPoint[] => Array.from({ length: count }, (_, t) => ({ t, remaining: t }));

  it('keeps the nearest anchors outside the viewport, including across a gap', () => {
    const points = ramp(100);
    const clipped = decimateSeries(points, 10, 90, 2);
    expect(clipped[0]).toBe(points[9]);
    expect(clipped.at(-1)).toBe(points[91]);
    expect(clipped.slice(1, -1).every((p) => p.t >= 10 && p.t <= 90)).toBe(true);
    expect(decimateSeries(points, 10.25, 10.75, 2)).toEqual(points.slice(10, 12));
    expect(decimateSeries(points, -10, -1, 2)).toEqual(points.slice(0, 1));
    expect(decimateSeries(points, 100, 110, 2)).toEqual(points.slice(-1));
    expect(decimateSeries([], 10, 90, 2)).toEqual([]);
  });

  it('returns the clipped slice for sparse data, zero width, or a collapsed range', () => {
    const points = ramp(20);
    expect(decimateSeries(points, 4, 7, 2.1)).toEqual(points.slice(3, 9));
    expect(decimateSeries(points, 3, 12, 0)).toEqual(points.slice(2, 14));
    expect(decimateSeries(points, 6, 6, 2)).toEqual(points.slice(5, 8));
    expect(decimateSeries(points, 12, 3, 2)).toEqual([]);
    const withDuplicates = [...points.slice(0, 6), { t: 5, remaining: 70 }, ...points.slice(6)];
    expect(decimateSeries(withDuplicates, 4, 5, 10)).toEqual(withDuplicates.slice(3, 8));
  });

  it('keeps first, last and extrema in index order, including a vertical reset within one column', () => {
    const points = [
      { t: -1, remaining: 99 },
      { t: 0, remaining: 40 }, { t: 5, remaining: 20 }, { t: 10, remaining: 5 },
      { t: 10, remaining: 100 }, { t: 15, remaining: 95 }, { t: 20, remaining: 90 },
      { t: 50, remaining: 60 }, { t: 55, remaining: 65 }, { t: 60, remaining: 75 },
      { t: 65, remaining: 5 }, { t: 70, remaining: 10 }, { t: 100, remaining: 20 },
      { t: 101, remaining: 50 },
    ];
    const wanted = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13];
    expect(decimateSeries(points, 0, 100, 2)).toEqual(wanted.map((i) => points[i]));
  });

  it('keeps a 10,000-point series ordered and within four points per column plus two anchors', () => {
    const points = ramp(10_000);
    const pixelWidth = 47.75;
    const clipped = decimateSeries(points, 155.5, 9_845.5, pixelWidth);
    expect(clipped.length).toBeGreaterThan(2);
    expect(clipped.length).toBeLessThanOrEqual(4 * Math.floor(pixelWidth) + 2);
    expect(clipped[0]).toBe(points[155]);
    expect(clipped.at(-1)).toBe(points[9_846]);
    expect(clipped.slice(1).every((p, i) => p.t > clipped[i]!.t)).toBe(true);
  });
});

describe('appendLivePoint', () => {
  it('replaces history samples at or after now and restores timestamp order after clock rollbacks', () => {
    const history: SeriesPoint[] = [{ t: 0, remaining: 50 }, { t: 60_000, remaining: 25 }, { t: 65_000, remaining: 25.4 }];
    const series = appendLivePoint(history, 60_000, 20);
    expect(series).toEqual([{ t: 0, remaining: 50 }, { t: 60_000, remaining: 20 }]);
    expect(decimateSeries(series, 0, 60_000, 100)).toEqual(series);
    expect(valueAt(series, 60_000)).toBe(20);
    expect(appendLivePoint([], 60_000, 80)).toEqual([{ t: 60_000, remaining: 80 }]);

    // Clock rollback leaves a future sample in the middle of history; both 150 and live 160 must survive.
    const rolledBack: SeriesPoint[] = [
      { t: 0, remaining: 90 }, { t: 100, remaining: 70 }, { t: 200, remaining: 60 },
      { t: 150, remaining: 40 }, { t: 160, remaining: 35 },
    ];
    const fixed = appendLivePoint(rolledBack, 160, 20);
    expect(fixed).toEqual([{ t: 0, remaining: 90 }, { t: 100, remaining: 70 }, { t: 150, remaining: 40 }, { t: 160, remaining: 20 }]);
    expect(decimateSeries(fixed, 100, 160, 100)).toEqual(fixed);
    expect(valueAt(fixed, 150)).toBe(40);
    expect(valueAt(fixed, 160)).toBe(20);
  });
});
