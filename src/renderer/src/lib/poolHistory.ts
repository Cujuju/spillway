import type { Credential, HistorySample } from '@shared/types';
import { consumedBetween } from '@shared/usageWindows';

/** Pool measures from usage history: drain rate, how windows move together, past remaining. */

const HOUR_MS = 60 * 60_000;
const FULL = 100;

export interface SeriesPoint {
  t: number;
  remaining: number;
}

const since = (samples: HistorySample[], from: number) => samples.filter((s) => Date.parse(s.at) >= from);

/** Percent of `key` used across `ids` over `samples`; use after a reset counts from zero. */
function consumed(samples: HistorySample[], ids: string[], key: string): number {
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

/** Percent of `key` used per hour across the pool inside the lookback. */
export function drainRatePerHour(samples: HistorySample[], ids: string[], key: string, now: number, lookbackHours: number): number | null {
  const inRange = since(samples, now - lookbackHours * HOUR_MS);
  if (inRange.length < 2) return null;
  const spanHours = (Date.parse(inRange.at(-1)!.at) - Date.parse(inRange[0]!.at)) / HOUR_MS;
  return spanHours > 0 ? consumed(inRange, ids, key) / spanHours : null;
}

/**
 * Percent each other window moved per 1% of `key` inside the lookback, pooled over `ids`.
 * Missing when `key` did not move. Assumption: accounts share one plan's ratio between windows.
 * For a scoped `key`, other traffic also moves the account-wide windows, so ratios run high.
 */
export function couplingRatios(samples: HistorySample[], ids: string[], key: string, now: number, lookbackHours: number): Record<string, number> {
  const inRange = since(samples, now - lookbackHours * HOUR_MS);
  const base = consumed(inRange, ids, key);
  if (base <= 0) return {};
  const keys = new Set(inRange.flatMap((s) => ids.flatMap((id) => Object.keys(s.used[id] ?? {}))));
  keys.delete(key);
  return Object.fromEntries([...keys].map((k) => [k, consumed(inRange, ids, k) / base]));
}

/**
 * Past remaining-pool values from history. Each account carries its last known value forward;
 * before its first sample it takes that sample's value, or its current one if it has no history.
 */
export function pastSeries(samples: HistorySample[], credentials: Credential[], key: string, from: number): SeriesPoint[] {
  const clamp = (v: number) => Math.min(FULL, Math.max(0, v));
  const last = new Map<string, number>();
  for (const c of credentials) {
    const current = c.disabled ? null : (c.windows.find((w) => w.key === key)?.usedPercent ?? null);
    if (current === null) continue;
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
    out.push({ t, remaining: [...last.values()].reduce((sum, used) => sum + (FULL - used), 0) });
  }
  return out;
}

/** Pool consumption rate (%/hour) between consecutive samples, for the Drain rate tab. */
export function drainSeries(samples: HistorySample[], ids: string[], key: string, from: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const t = Date.parse(b.at);
    if (t < from) continue;
    const hours = (t - Date.parse(a.at)) / HOUR_MS;
    if (hours <= 0) continue;
    const total = ids.reduce((sum, id) => sum + (consumedBetween(a, b, id, key) ?? 0), 0);
    out.push({ t, remaining: total / hours });
  }
  return out;
}
