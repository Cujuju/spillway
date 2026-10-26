import type { Credential, HistorySample } from '@shared/types';
import { consumedBetween } from '@shared/usageWindows';
import type { AccountShare } from './poolCapacity';

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
  const last = new Map<string, number>();
  for (const c of credentials) {
    const current = c.windows.find((w) => w.key === key)?.usedPercent ?? null;
    if (!shares.has(c.id) || current === null) continue;
    const first = samples.find((s) => s.used[c.id]?.[key] !== undefined);
    last.set(c.id, clamp(first ? first.used[c.id]![key]! : current));
  }
  const out: SeriesPoint[] = [];
  for (const s of samples) {
    for (const id of last.keys()) {
      const v = s.used[id]?.[key];
      if (v !== undefined) last.set(id, clamp(v));
    }
    const t = Date.parse(s.at);
    if (t < from || last.size === 0) continue;
    out.push({ t, remaining: [...last].reduce((sum, [id, used]) => sum + shares.get(id)!.share * (FULL - used), 0) });
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
