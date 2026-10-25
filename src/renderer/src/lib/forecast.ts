import type { Credential, HistorySample } from '@shared/types';

/** Pool forecast for one provider and one limit window (Theo-style remaining-quota chart). */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const FULL = 100;
/** 15-minute steps resolve a 5-hour window and keep a 14-day projection under 1.4k points. */
const STEP_MS = 15 * 60_000;

/** Window period from the proxy's key; unknown keys get no recurring reset. */
export function windowPeriodMs(key: string): number | null {
  const k = key.toLowerCase();
  if (/five_hour|5h|primary/.test(k)) return 5 * HOUR_MS;
  if (/daily|day_1|24h/.test(k)) return DAY_MS;
  if (/seven_day|weekly|7d|secondary/.test(k)) return 7 * DAY_MS;
  if (/month/.test(k)) return 30 * DAY_MS;
  return null;
}

/** The longest window the accounts report; it bounds how long the pool lasts. */
export function poolWindowKey(credentials: Credential[]): string | null {
  let best: { key: string; period: number } | null = null;
  for (const c of credentials) {
    for (const w of c.windows) {
      const period = windowPeriodMs(w.key) ?? 0;
      if (w.usedPercent !== null && (!best || period > best.period)) best = { key: w.key, period };
    }
  }
  return best?.key ?? null;
}

interface Account {
  id: string;
  used: number;
  resetAt: number | null;
}

function accountsFor(credentials: Credential[], key: string): Account[] {
  return credentials
    .filter((c) => !c.disabled)
    .flatMap((c) => {
      const w = c.windows.find((x) => x.key === key);
      if (!w || w.usedPercent === null) return [];
      return [{ id: c.id, used: Math.min(FULL, Math.max(0, w.usedPercent)), resetAt: w.resetsAt ? Date.parse(w.resetsAt) : null }];
    });
}

export interface PoolSummary {
  remaining: number;
  capacity: number;
  accounts: number;
}

export function poolSummary(credentials: Credential[], key: string): PoolSummary {
  const accounts = accountsFor(credentials, key);
  return { remaining: accounts.reduce((sum, a) => sum + (FULL - a.used), 0), capacity: accounts.length * FULL, accounts: accounts.length };
}

/** Percent used per hour across the pool: summed increases inside the lookback, resets ignored. */
export function drainRatePerHour(samples: HistorySample[], ids: string[], key: string, now: number, lookbackHours: number): number | null {
  const from = now - lookbackHours * HOUR_MS;
  const inRange = samples.filter((s) => Date.parse(s.at) >= from);
  if (inRange.length < 2) return null;
  let consumed = 0;
  for (const id of ids) {
    let prev: number | undefined;
    for (const s of inRange) {
      const v = s.used[id]?.[key];
      if (v === undefined) continue;
      if (prev !== undefined && v > prev) consumed += v - prev;
      prev = v;
    }
  }
  const spanHours = (Date.parse(inRange.at(-1)!.at) - Date.parse(inRange[0]!.at)) / HOUR_MS;
  return spanHours > 0 ? consumed / spanHours : null;
}

export interface SeriesPoint {
  t: number;
  remaining: number;
}

/** Past remaining-pool values from history, carrying each account's last known value forward. */
export function pastSeries(samples: HistorySample[], ids: string[], key: string, from: number): SeriesPoint[] {
  const last = new Map<string, number>();
  for (const id of ids) {
    const first = samples.find((s) => s.used[id]?.[key] !== undefined);
    if (first) last.set(id, first.used[id]![key]!);
  }
  const out: SeriesPoint[] = [];
  for (const s of samples) {
    for (const id of ids) {
      const v = s.used[id]?.[key];
      if (v !== undefined) last.set(id, v);
    }
    const t = Date.parse(s.at);
    if (t < from || last.size === 0) continue;
    out.push({ t, remaining: [...last.values()].reduce((sum, used) => sum + (FULL - used), 0) });
  }
  return out;
}

export interface Projection {
  points: SeriesPoint[];
  /** First upcoming reset and the percent it restores. */
  nextReset: { at: number; restores: number } | null;
}

/**
 * Projects the pool forward: drain comes out of the soonest-resetting account first
 * (the proxy's soonest-reset order), and each account refills at its reset.
 */
export function project(credentials: Credential[], key: string, ratePerHour: number, now: number, days: number): Projection {
  const period = windowPeriodMs(key);
  const accounts = accountsFor(credentials, key).map((a) => ({ ...a }));
  const end = now + days * DAY_MS;
  const points: SeriesPoint[] = [];
  let nextReset: Projection['nextReset'] = null;
  const drainPerStep = (ratePerHour * STEP_MS) / HOUR_MS;

  for (let t = now; t <= end; t += STEP_MS) {
    let restored = 0;
    for (const a of accounts) {
      if (a.resetAt === null || a.resetAt > t) continue;
      restored += a.used;
      a.used = 0;
      a.resetAt = period ? a.resetAt + period * Math.ceil((t - a.resetAt + 1) / period) : null;
    }
    if (restored > 0 && !nextReset && t > now) nextReset = { at: t, restores: restored };
    let toDrain = t === now ? 0 : drainPerStep;
    const order = [...accounts].sort((x, y) => (x.resetAt ?? Infinity) - (y.resetAt ?? Infinity));
    for (const a of order) {
      if (toDrain <= 0) break;
      const take = Math.min(FULL - a.used, toDrain);
      a.used += take;
      toDrain -= take;
    }
    points.push({ t, remaining: accounts.reduce((sum, a) => sum + (FULL - a.used), 0) });
  }
  return { points, nextReset };
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
    let consumed = 0;
    for (const id of ids) {
      const x = a.used[id]?.[key];
      const y = b.used[id]?.[key];
      if (x !== undefined && y !== undefined && y > x) consumed += y - x;
    }
    out.push({ t, remaining: consumed / hours });
  }
  return out;
}

/** First projected time the pool hits zero, or null if it lasts the whole projection. */
export function depletionAt(points: SeriesPoint[]): number | null {
  return points.find((p) => p.remaining <= 0)?.t ?? null;
}
