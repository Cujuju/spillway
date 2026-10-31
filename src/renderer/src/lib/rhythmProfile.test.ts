import { describe, expect, it } from 'vitest';
import type { ActivityBucket } from '@shared/types';
import { FLAT_RHYTHM, RHYTHM_FLAT_SHARE, RHYTHM_LOOKBACK_DAYS, RHYTHM_MIN_DAYS, RHYTHM_MIN_PRICED_SHARE, rhythmProfile, weightedHours } from './rhythmProfile';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse('2026-10-25T23:00:00Z');
const utc = () => 0;
const bucket = (start: number, costUsd = 1, patch: Partial<ActivityBucket> = {}): ActivityBucket => ({
  start, costUsd, wholeDay: false, provider: 'claude', authIndex: 'a', model: 'model', client: null,
  requests: 1, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
  uncachedCostUsd: costUsd, unpricedRequests: 0, ...patch,
});
const evidence = (days = RHYTHM_MIN_DAYS) => Array.from({ length: days }, (_, d) => bucket(NOW - 13 * H - d * DAY));

describe('rhythmProfile', () => {
  it('normalizes provider cost to mean one and floors quiet hours with a flat blend', () => {
    const profile = rhythmProfile([...evidence(), bucket(NOW, 1e9, { provider: 'codex' })], 'claude', NOW, utc);
    expect(profile.reduce((a, b) => a + b, 0) / 24).toBeCloseTo(1);
    expect(profile[10]).toBeCloseTo(24 * (1 - RHYTHM_FLAT_SHARE) + RHYTHM_FLAT_SHARE);
    expect(profile.filter((_, h) => h !== 10).every((n) => n === RHYTHM_FLAT_SHARE)).toBe(true);
  });
  it('requires distinct local days, not bucket count', () => {
    const short = evidence(RHYTHM_MIN_DAYS - 1);
    expect(rhythmProfile([...short, ...short], 'claude', NOW, utc)).toEqual(FLAT_RHYTHM);
  });
  it('skips whole-day totals, including when counting evidence days', () => {
    const short = evidence(RHYTHM_MIN_DAYS - 1);
    const daily = bucket(NOW - 10 * DAY, 1e9, { wholeDay: true });
    expect(rhythmProfile([...short, daily], 'claude', NOW, utc)).toEqual(FLAT_RHYTHM);
    expect(rhythmProfile([...evidence(), daily], 'claude', NOW, utc)).toEqual(rhythmProfile(evidence(), 'claude', NOW, utc));
  });
  it('keeps exactly the latest 21 local calendar days and excludes future data', () => {
    const oldest = bucket(NOW - 20 * DAY - 23 * H, 2);
    const outside = bucket(oldest.start - 1, 1e9);
    const future = bucket(NOW + H, 1e9);
    const expected = rhythmProfile([...evidence(), oldest], 'claude', NOW, utc);
    expect(RHYTHM_LOOKBACK_DAYS).toBe(21);
    expect(expected[0]).toBeGreaterThan(RHYTHM_FLAT_SHARE);
    expect(rhythmProfile([...evidence(), oldest, outside, future], 'claude', NOW, utc)).toEqual(expected);
  });
  it('uses the injected local timezone for hour and calendar-day grouping', () => {
    const profile = rhythmProfile(evidence(), 'claude', NOW, () => 7 * 60);
    expect(profile[3]).toBeGreaterThan(1);
    expect(profile[10]).toBe(RHYTHM_FLAT_SHARE);
  });
  it('uses all token fields when a priced minority would reverse the rhythm', () => {
    const morning = evidence().map((b) => ({ ...b, requests: 1000, unpricedRequests: 1000, costUsd: 0,
      inputTokens: 1000, outputTokens: 2000, cachedTokens: 3000, cacheWriteTokens: 4000 }));
    const evening = bucket(NOW - 3 * H, 0.001, { inputTokens: 1 });
    const profile = rhythmProfile([...morning, evening], 'claude', NOW, utc);
    const tokens = RHYTHM_MIN_DAYS * 10000;
    expect(profile[10]).toBeCloseTo(RHYTHM_FLAT_SHARE + (1 - RHYTHM_FLAT_SHARE) * 24 * tokens / (tokens + 1));
    expect(profile[10]).toBeGreaterThan(profile[20]!);
  });
  it('keeps cost weighting at the pricing coverage threshold and when fully priced', () => {
    for (const unpricedRequests of [0, (1 - RHYTHM_MIN_PRICED_SHARE) * 100]) {
      const morning = evidence().map((b) => ({ ...b, requests: 100, unpricedRequests, inputTokens: 100000 }));
      const evening = bucket(NOW - 3 * H, 100, { inputTokens: 1 });
      const profile = rhythmProfile([...morning, evening], 'claude', NOW, utc);
      expect(profile[20]).toBeCloseTo(RHYTHM_FLAT_SHARE + (1 - RHYTHM_FLAT_SHARE) * 24 * 100 / (100 + RHYTHM_MIN_DAYS));
      expect(profile[20]).toBeGreaterThan(profile[10]!);
    }
  });
  it('counts only days with positive evidence of the selected weight', () => {
    const costDays = evidence().map((b, i) => ({ ...b, costUsd: i ? 0 : 1, inputTokens: 1 }));
    expect(rhythmProfile(costDays, 'claude', NOW, utc)).toEqual(FLAT_RHYTHM);
    const tokenDays = evidence().map((b, i) => ({ ...b, unpricedRequests: 1, inputTokens: i ? 0 : 1 }));
    expect(rhythmProfile(tokenDays, 'claude', NOW, utc)).toEqual(FLAT_RHYTHM);
  });
  it('falls back to flat without evidence of either weight', () => {
    expect(rhythmProfile(evidence().map((b) => ({ ...b, costUsd: 0 })), 'claude', NOW, utc)).toEqual(FLAT_RHYTHM);
    expect(rhythmProfile(evidence().map((b) => ({ ...b, costUsd: 0, unpricedRequests: 1 })), 'claude', NOW, utc)).toEqual(FLAT_RHYTHM);
  });
});

describe('weightedHours', () => {
  it('integrates partial local hours and preserves the daily total', () => {
    const profile = Array<number>(24).fill(0.1);
    profile[10] = 21.7;
    const midnight = NOW - 23 * H;
    expect(weightedHours(midnight + 9.5 * H, midnight + 10.5 * H, profile, utc)).toBeCloseTo(10.9);
    expect(weightedHours(midnight, midnight + DAY, profile, utc)).toBeCloseTo(24);
    expect(weightedHours(NOW, NOW + 123456, FLAT_RHYTHM, utc)).toBe(123456 / H);
  });
  it('uses timezone offsets on both sides of a DST transition', () => {
    const transition = Date.parse('2026-11-01T09:00:00Z');
    const offset = (t: number) => t < transition ? 420 : 480;
    const profile = Array<number>(24).fill(1);
    profile[1] = 3;
    expect(weightedHours(transition - H, transition + H, profile, offset)).toBe(6);
  });
});
