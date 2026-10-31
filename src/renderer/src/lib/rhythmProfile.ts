import type { ActivityBucket } from '@shared/types';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Long enough to average out an odd week, short enough to follow a schedule change within weeks. */
export const RHYTHM_LOOKBACK_DAYS = 21;
/** A week's hourly evidence avoids learning a schedule from a brief burst. */
export const RHYTHM_MIN_DAYS = 7;
/** Leave some demand in unfamiliar work hours. */
export const RHYTHM_FLAT_SHARE = 0.05;
export type RhythmProfile = readonly number[];
export const FLAT_RHYTHM: RhythmProfile = Object.freeze(Array<number>(24).fill(1));
/** Minutes west of UTC; injectable for deterministic local hours and DST tests. */
export type TimezoneOffset = (t: number) => number;
export const localOffset: TimezoneOffset = (t) => new Date(t).getTimezoneOffset();
const localTime = (t: number, offset: TimezoneOffset) => t - offset(t) * 60_000;
export const localHour = (t: number, offset: TimezoneOffset) => new Date(localTime(t, offset)).getUTCHours();
export const nextLocalHour = (t: number, offset: TimezoneOffset) => t + HOUR_MS - ((localTime(t, offset) % HOUR_MS + HOUR_MS) % HOUR_MS);

/** Learn hourly demand from total tokens. */
export function rhythmProfile(buckets: ActivityBucket[], provider: string, now: number, offset: TimezoneOffset = localOffset): RhythmProfile {
  const today = Math.floor(localTime(now, offset) / DAY_MS);
  const evidence = buckets.filter((b) => !b.wholeDay && b.provider === provider && b.start <= now
    && Math.floor(localTime(b.start, offset) / DAY_MS) > today - RHYTHM_LOOKBACK_DAYS);
  const days = new Set<number>();
  const hours = Array<number>(24).fill(0);
  for (const b of evidence) {
    const weight = Math.max(0, b.inputTokens + b.outputTokens + b.cachedTokens + b.cacheWriteTokens);
    if (weight <= 0) continue;
    const day = Math.floor(localTime(b.start, offset) / DAY_MS);
    days.add(day);
    hours[localHour(b.start, offset)]! += weight;
  }
  const total = hours.reduce((sum, n) => sum + n, 0);
  if (days.size < RHYTHM_MIN_DAYS || total <= 0) return FLAT_RHYTHM;
  return hours.map((n) => RHYTHM_FLAT_SHARE + (1 - RHYTHM_FLAT_SHARE) * n * 24 / total);
}

/** Integrates piecewise-constant local-hour demand, preserving elapsed hours exactly for a flat profile. */
export function weightedHours(from: number, to: number, profile: RhythmProfile, offset: TimezoneOffset): number {
  if (profile.every((n) => n === 1)) return (to - from) / HOUR_MS;
  let hours = 0;
  for (let t = from; t < to;) {
    const next = Math.min(to, nextLocalHour(t, offset));
    hours += (next - t) / HOUR_MS * profile[localHour(t, offset)]!;
    t = next;
  }
  return hours;
}
