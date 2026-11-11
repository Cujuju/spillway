import type { Credential, HistorySample } from '@shared/types';
import { consumedBetween } from '@shared/usageWindows';
import type { AccountShare } from './poolCapacity';
import { accountsFor, remainingOf } from './forecastState';

/** Pool measures from usage history, in percent of the whole pool (see poolCapacity). */

const HOUR_MS = 60 * 60_000;
const FULL = 100;

export interface SeriesPoint {
  t: number;
  remaining: number;
}

const since = (samples: HistorySample[], from: number) => samples.filter((s) => Date.parse(s.at) >= from);

/** Percent of `key` used across `ids` over `samples`; use after a reset counts from zero. */
export function consumed(samples: HistorySample[], ids: string[], key: string): number {
  let total = 0;
  for (const id of ids) {
    let prev: HistorySample | undefined;
    for (const s of samples) {
      if (s.used[id]?.[key] === undefined) continue;
      if (prev) total += consumedBetween(prev, s, id, key) ?? 0;
      prev = s;
    }
  }
  return total;
}

/** Pool percent `key` used, weighting each account by its share of the pool. */
const pooled = (samples: HistorySample[], shares: Map<string, AccountShare>, key: string) =>
  [...shares].reduce((sum, [id, a]) => sum + a.share * consumed(samples, [id], key), 0);

/** Pool percent of `key` used per hour inside the lookback. */
export function drainRatePerHour(samples: HistorySample[], shares: Map<string, AccountShare>, key: string, now: number, lookbackHours: number): number | null {
  const inRange = since(samples, now - lookbackHours * HOUR_MS);
  if (inRange.length < 2) return null;
  const spanHours = (Date.parse(inRange.at(-1)!.at) - Date.parse(inRange[0]!.at)) / HOUR_MS;
  return spanHours > 0 ? pooled(inRange, shares, key) / spanHours : null;
}

/**
 * Past pool percent remaining. Each account carries its last known value forward; before its
 * first sample it takes that sample's value, or its current one if it has no history.
 */
export function pastSeries(samples: HistorySample[], credentials: Credential[], key: string, from: number, shares: Map<string, AccountShare>): SeriesPoint[] {
  const clamp = (v: number) => Math.min(FULL, Math.max(0, v));
  const accounts = accountsFor(credentials, key, shares);
  for (const a of accounts) {
    const first = samples.find((s) => s.used[a.id]?.[key] !== undefined);
    for (const w of a.windows) {
      w.used = w.key === key ? clamp(first?.used[a.id]?.[key] ?? w.used) : 0;
      // History records percentages; current rejection states cannot describe past availability.
      w.rejected = false;
    }
  }
  const out: SeriesPoint[] = [];
  for (const s of samples) {
    for (const a of accounts) for (const w of a.windows) {
      const v = s.used[a.id]?.[w.key];
      if (v !== undefined) w.used = clamp(v);
    }
    const t = Date.parse(s.at);
    if (t < from || !accounts.length) continue;
    out.push({ t, remaining: remainingOf(accounts) });
  }
  return out;
}

/** Pool consumption rate (pool %/hour) between consecutive samples, for the Drain rate tab. */
export function drainSeries(samples: HistorySample[], shares: Map<string, AccountShare>, key: string, from: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const t = Date.parse(b.at);
    if (t < from) continue;
    const hours = (t - Date.parse(a.at)) / HOUR_MS;
    if (hours <= 0) continue;
    const total = [...shares].reduce((sum, [id, x]) => sum + x.share * (consumedBetween(a, b, id, key) ?? 0), 0);
    out.push({ t, remaining: total / hours });
  }
  return out;
}
