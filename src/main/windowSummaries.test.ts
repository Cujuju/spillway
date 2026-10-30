import { describe, expect, it } from 'vitest';
import type { HistorySample, WindowSummary } from '@shared/types';
import { foldSample, pruneSummaries } from './windowSummaries';

const HOUR = 3_600_000;
const sample = (at: string, used: number, reset?: string | number): HistorySample => ({
  at, used: { a: { seven_day: used } },
  resets: reset === undefined ? undefined : { a: { seven_day: typeof reset === 'number' ? reset : Date.parse(reset) } },
});
const fold = (points: HistorySample[]) => points.reduce(foldSample, [] as WindowSummary[]);
const t = (iso: string) => Date.parse(iso);
const window = (first: string, last: string, reset: string, peak: number, exhausted: string | null = null, ended: string | null = null): WindowSummary => ({
  credentialId: 'a', key: 'seven_day', firstSampleAt: t(first), lastSampleAt: t(last), resetAt: t(reset),
  endedAt: ended === null ? null : t(ended), peak, exhaustedAt: exhausted === null ? null : t(exhausted),
});

describe('foldSample', () => {
  it('keeps readings of one reset in one window despite seconds of jitter, with its first reset reading', () => {
    const points = [
      sample('2026-10-25T16:45:00Z', 80, '2026-10-25T17:00:00Z'),
      sample('2026-10-25T16:50:00Z', 100, '2026-10-25T16:59:59Z'),
      sample('2026-10-25T16:55:00Z', 105, '2026-10-25T17:00:03Z'),
    ];
    expect(fold(points)).toEqual([window('2026-10-25T16:45:00Z', '2026-10-25T16:55:00Z', '2026-10-25T17:00:00Z', 105, '2026-10-25T16:50:00Z')]);
  });

  it('starts the next window when a reading reports a later reset, even before the old reset passed', () => {
    const points = [sample('2026-10-25T16:59:59Z', 90, '2026-10-25T17:00:01Z'), sample('2026-10-25T17:00:00Z', 2, '2026-11-01T17:00:00Z')];
    expect(fold(points)).toEqual([
      window('2026-10-25T16:59:59Z', '2026-10-25T16:59:59Z', '2026-10-25T17:00:01Z', 90),
      window('2026-10-25T17:00:00Z', '2026-10-25T17:00:00Z', '2026-11-01T17:00:00Z', 2),
    ]);
  });

  it('replaces an unstarted window whose reset rolls a full window ahead of each reading (Codex idle)', () => {
    const idle = (at: string) => sample(at, 0, t(at) + 5 * HOUR);
    const points = [idle('2026-10-27T10:00:00Z'), idle('2026-10-27T10:15:00Z'), idle('2026-10-27T10:30:00Z'), sample('2026-10-27T10:31:00Z', 1, '2026-10-27T15:31:00Z')];
    // The last idle reading's rolling reset is within tolerance of the started one, so it joins that window.
    expect(fold(points)).toEqual([window('2026-10-27T10:30:00Z', '2026-10-27T10:31:00Z', '2026-10-27T15:30:00Z', 1)]);
  });

  it('ends a used window early when a new window begins before its reset (reset credit)', () => {
    const points = [sample('2026-10-26T17:55:00Z', 3, '2026-10-27T01:59:43Z'), sample('2026-10-26T17:59:27Z', 0, '2026-10-26T22:49:30Z')];
    expect(fold(points)).toEqual([
      window('2026-10-26T17:55:00Z', '2026-10-26T17:55:00Z', '2026-10-27T01:59:43Z', 3, null, '2026-10-26T17:59:27Z'),
      window('2026-10-26T17:59:27Z', '2026-10-26T17:59:27Z', '2026-10-26T22:49:30Z', 0),
    ]);
  });

  it('skips keys without a recorded reset and does not mutate its input', () => {
    const stored = fold([sample('2026-10-25T16:45:00Z', 80, '2026-10-25T17:00:00Z')]);
    const copy = structuredClone(stored);
    const idle = sample('2026-10-25T16:58:00Z', 0);
    idle.used.a!.five_hour = 0;
    expect(foldSample(stored, idle)).toEqual(copy);
    foldSample(stored, sample('2026-10-25T16:50:00Z', 90, '2026-10-25T17:00:00Z'));
    expect(stored).toEqual(copy);
  });

  it('keeps accounts and keys separate', () => {
    const mixed: HistorySample = {
      at: '2026-10-25T16:45:00Z', used: { a: { five_hour: 5, seven_day: 10 }, b: { seven_day: 10 } },
      resets: { a: { five_hour: t('2026-10-25T20:00:00Z'), seven_day: t('2026-10-30T17:00:00Z') }, b: { seven_day: t('2026-10-30T17:00:00Z') } },
    };
    expect(foldSample([], mixed).map((s) => [s.credentialId, s.key])).toEqual([['a', 'five_hour'], ['a', 'seven_day'], ['b', 'seven_day']]);
  });
});

describe('pruneSummaries', () => {
  const used = window('2026-10-25T16:45:00Z', '2026-10-25T16:55:00Z', '2026-10-25T17:00:00Z', 50);
  it('drops windows older than one year and keeps the boundary', () => {
    const now = used.resetAt + 365 * 24 * HOUR;
    expect(pruneSummaries([{ ...used, resetAt: used.resetAt - 1 }, used], now)).toEqual([used]);
  });

  it('drops finished windows that never saw use, but keeps the current one', () => {
    const unused = { ...used, peak: 0 };
    expect(pruneSummaries([unused], used.resetAt + HOUR)).toEqual([]);
    expect(pruneSummaries([unused], used.resetAt - HOUR)).toEqual([unused]);
  });
});
