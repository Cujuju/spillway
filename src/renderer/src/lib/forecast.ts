import type { Credential, HistorySample } from '@shared/types';
import { consumedBetween } from '@shared/usageWindows';

/** Pool forecast for one provider and one limit window (Theo-style remaining-quota chart). */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const FULL = 100;
/** 15-minute steps resolve a 5-hour window and keep a 14-day projection under 1.4k points. */
const STEP_MS = 15 * 60_000;
/** Proxy routing strategies (routing.strategy) that pick accounts in a fixed order. */
const SOONEST_RESET = 'soonest-reset';
const FILL_FIRST = 'fill-first';

/** Default pool window: the longest account-wide window with data, the slowest to refill. */
export function poolWindowKey(credentials: Credential[]): string | null {
  let best: { key: string; durationMs: number; scoped: boolean } | null = null;
  for (const c of credentials) {
    for (const w of c.windows) {
      if (w.usedPercent === null) continue;
      const durationMs = w.durationMs ?? 0;
      const better = !best || (best.scoped && !w.scoped) || (best.scoped === w.scoped && durationMs > best.durationMs);
      if (better) best = { key: w.key, durationMs, scoped: w.scoped };
    }
  }
  return best?.key ?? null;
}

interface Account {
  id: string;
  used: number;
  resetAt: number | null;
  durationMs: number | null;
  priority: number;
  preferred: boolean;
  cooldownUntil: number | null;
  /** Account-wide windows, in the proxy's order, for soonest-reset ranking. */
  rankWindows: { durationMs: number; resetAt: number | null; projected: boolean }[];
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

function accountsFor(credentials: Credential[], key: string): Account[] {
  return credentials
    .filter((c) => !c.disabled)
    .flatMap((c) => {
      const w = c.windows.find((x) => x.key === key);
      if (!w || w.usedPercent === null) return [];
      return [{
        id: c.id,
        used: Math.min(FULL, Math.max(0, w.usedPercent)),
        resetAt: ms(w.resetsAt),
        durationMs: w.durationMs,
        priority: c.priority,
        preferred: c.preferred,
        cooldownUntil: ms(c.cooldownUntil),
        rankWindows: c.windows.filter((x) => !x.scoped).map((x) => ({ durationMs: x.durationMs ?? 0, resetAt: ms(x.resetsAt), projected: x.key === key })),
      }];
    });
}

const remainingOf = (accounts: Account[]) => accounts.reduce((sum, a) => sum + (FULL - a.used), 0);

export interface PoolSummary {
  remaining: number;
  capacity: number;
  accounts: number;
}

/** Expects windows already rolled past their resets (the store's snapshot is). */
export function poolSummary(credentials: Credential[], key: string): PoolSummary {
  const accounts = accountsFor(credentials, key);
  return { remaining: remainingOf(accounts), capacity: accounts.length * FULL, accounts: accounts.length };
}

/** Percent used per hour across the pool inside the lookback; use after a reset counts from zero. */
export function drainRatePerHour(samples: HistorySample[], ids: string[], key: string, now: number, lookbackHours: number): number | null {
  const from = now - lookbackHours * HOUR_MS;
  const inRange = samples.filter((s) => Date.parse(s.at) >= from);
  if (inRange.length < 2) return null;
  let consumed = 0;
  for (const id of ids) {
    let prev: HistorySample | undefined;
    for (const s of inRange) {
      if (s.used[id]?.[key] === undefined) continue;
      if (prev) consumed += consumedBetween(prev, s, id, key) ?? 0;
      prev = s;
    }
  }
  const spanHours = (Date.parse(inRange.at(-1)!.at) - Date.parse(inRange[0]!.at)) / HOUR_MS;
  return spanHours > 0 ? consumed / spanHours : null;
}

export interface SeriesPoint {
  t: number;
  remaining: number;
}

/**
 * Past remaining-pool values from history. Each account carries its last known value forward;
 * before its first sample it takes that sample's value, or its current one if it has no history.
 */
export function pastSeries(samples: HistorySample[], credentials: Credential[], key: string, from: number): SeriesPoint[] {
  const last = new Map<string, number>();
  for (const a of accountsFor(credentials, key)) {
    const first = samples.find((s) => s.used[a.id]?.[key] !== undefined);
    last.set(a.id, first ? first.used[a.id]![key]! : a.used);
  }
  const out: SeriesPoint[] = [];
  for (const s of samples) {
    for (const id of last.keys()) {
      const v = s.used[id]?.[key];
      if (v !== undefined) last.set(id, Math.min(FULL, Math.max(0, v)));
    }
    const t = Date.parse(s.at);
    if (t < from || last.size === 0) continue;
    out.push({ t, remaining: [...last.values()].reduce((sum, used) => sum + (FULL - used), 0) });
  }
  return out;
}

/** The proxy's soonest-reset rank: the longest account-wide window's reset, then the shortest's; unknown or past last. */
function resetRank(a: Account, t: number): [number, number] {
  const live = a.rankWindows
    .map((w) => ({ durationMs: w.durationMs, resetAt: w.projected ? a.resetAt : w.resetAt }))
    .filter((w): w is { durationMs: number; resetAt: number } => w.resetAt !== null && w.resetAt > t);
  if (!live.length) return [Infinity, Infinity];
  let long = live[0]!;
  let short = live[0]!;
  for (const w of live) {
    if (w.durationMs > long.durationMs) long = w;
    if (w.durationMs < short.durationMs) short = w;
  }
  return [long.resetAt, long.durationMs === short.durationMs ? Infinity : short.resetAt];
}

/** Ordered strategies' pick order at `t`; null for rotating strategies. Ties fall to credential ID, as in the proxy. */
function pickOrder(open: Account[], t: number, strategy: string): Account[] | null {
  const byId = (x: Account, y: Account) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  if (strategy === FILL_FIRST) return [...open].sort((x, y) => y.priority - x.priority || byId(x, y));
  if (strategy !== SOONEST_RESET) return null;
  const rank = new Map(open.map((a) => [a, resetRank(a, t)]));
  return [...open].sort((x, y) => {
    const [xl, xs] = rank.get(x)!;
    const [yl, ys] = rank.get(y)!;
    return xl - yl || xs - ys || byId(x, y);
  });
}

/** Adds use to one account and returns what it took. An unused window with no reset starts on this use. */
function take(a: Account, want: number, t: number): number {
  const headroom = FULL - a.used;
  const got = Math.min(headroom, want);
  if (got <= 0) return 0;
  if (a.used === 0 && a.resetAt === null && a.durationMs !== null) a.resetAt = t + a.durationMs;
  a.used = got === headroom ? FULL : a.used + got;
  return got;
}

/**
 * Spends `amount` the way the proxy routes: the preferred account first, then the strategy's
 * order. Rotating strategies spread it evenly over the accounts with room. Benched accounts get none.
 */
function spend(accounts: Account[], amount: number, t: number, strategy: string): void {
  let open = accounts.filter((a) => a.used < FULL && (a.cooldownUntil === null || a.cooldownUntil <= t));
  const preferred = open.find((a) => a.preferred);
  if (preferred) {
    amount -= take(preferred, amount, t);
    open = open.filter((a) => a !== preferred);
  }
  const order = pickOrder(open, t, strategy);
  if (order) {
    for (const a of order) amount -= take(a, amount, t);
    return;
  }
  // Even split: fill the smallest headroom first so its unused share passes to the rest.
  const byHeadroom = [...open].sort((x, y) => y.used - x.used);
  byHeadroom.forEach((a, i) => {
    amount -= take(a, amount / (byHeadroom.length - i), t);
  });
}

export interface Projection {
  points: SeriesPoint[];
  /** First upcoming reset and the percent it restores. */
  nextReset: { at: number; restores: number } | null;
}

/**
 * Projects the pool forward at a steady drain, routed as the proxy would (`strategy`).
 * Each account refills at its reset. Assumption: a reset window starts again on the account's
 * next use, as Claude's 5-hour window does, so the next reset is a window length after that.
 */
export function project(credentials: Credential[], key: string, ratePerHour: number, now: number, days: number, strategy: string): Projection {
  const accounts = accountsFor(credentials, key);
  const end = now + days * DAY_MS;
  const points: SeriesPoint[] = [{ t: now, remaining: remainingOf(accounts) }];
  let nextReset: Projection['nextReset'] = null;
  const drainPerStep = (ratePerHour * STEP_MS) / HOUR_MS;

  for (let t = now + STEP_MS; t <= end; t += STEP_MS) {
    let restored = 0;
    let firstAt = Infinity;
    for (const a of accounts) {
      if (a.resetAt === null || a.resetAt > t) continue;
      restored += a.used;
      firstAt = Math.min(firstAt, a.resetAt);
      a.used = 0;
      a.resetAt = null;
    }
    if (restored > 0 && !nextReset) nextReset = { at: firstAt, restores: restored };
    spend(accounts, drainPerStep, t, strategy);
    points.push({ t, remaining: remainingOf(accounts) });
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
    const consumed = ids.reduce((sum, id) => sum + (consumedBetween(a, b, id, key) ?? 0), 0);
    out.push({ t, remaining: consumed / hours });
  }
  return out;
}

/** First projected time the pool hits zero, or null if it lasts the whole projection. */
export function depletionAt(points: SeriesPoint[]): number | null {
  return points.find((p) => p.remaining <= 0)?.t ?? null;
}
