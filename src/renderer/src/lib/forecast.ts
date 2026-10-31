import type { Credential, LimitWindow } from '@shared/types';
import { nextResetAfter } from '@shared/usageWindows';
import type { AccountShare } from './poolCapacity';
import type { SeriesPoint } from './poolHistory';

/** Pool forecast for one provider and one limit window, in percent of the whole pool (see poolCapacity). */

const HOUR_MS = 60 * 60_000;
const FULL = 100;
/** 15-minute steps resolve a 5-hour window and keep a 14-day projection under 1.4k points. */
const STEP_MS = 15 * 60_000;
/** Bound unknown or distant reset horizons while covering weekly caps and recovery. */
const MAX_SIMULATION_MS = 28 * 24 * HOUR_MS;
/** Proxy routing strategies (routing.strategy) the projection models specifically. */
const SOONEST_RESET = 'soonest-reset';
const FILL_FIRST = 'fill-first';
const WEIGHTED_ROUND_ROBIN = 'weighted-round-robin';

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

interface Win {
  used: number;
  resetAt: number | null;
  durationMs: number | null;
  resetCadence: LimitWindow['resetCadence'];
  scoped: boolean;
  /** Account percent of this window used per 1% of the pool; 0 leaves it out of the cap. */
  cost: number;
}

interface Account {
  id: string;
  priority: number;
  weight: number;
  preferred: boolean;
  cooldownUntil: number | null;
  /** Fraction of the pool's capacity this account holds. */
  share: number;
  /** The projected window first, then the account-wide windows that also cap it. */
  windows: Win[];
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);
const toWin = (w: LimitWindow, cost: number): Win => ({
  used: Math.min(FULL, Math.max(0, w.usedPercent ?? 0)),
  resetAt: ms(w.resetsAt),
  durationMs: w.durationMs,
  resetCadence: w.resetCadence,
  scoped: w.scoped,
  cost: w.usedPercent === null ? 0 : cost,
});

function accountsFor(credentials: Credential[], key: string, shares: Map<string, AccountShare>): Account[] {
  return credentials.flatMap((c) => {
    const s = shares.get(c.id);
    const w = c.windows.find((x) => x.key === key);
    if (!s || !w || w.usedPercent === null) return [];
    const others = c.windows.filter((x) => x.key !== key && !x.scoped).map((x) => toWin(x, s.cost[x.key] ?? 0));
    return [{
      id: c.id,
      priority: c.priority,
      weight: c.weight,
      preferred: c.preferred,
      cooldownUntil: ms(c.cooldownUntil),
      share: s.share,
      windows: [toWin(w, s.cost[key]!), ...others],
    }];
  });
}

const remainingOf = (accounts: Account[]) => accounts.reduce((sum, a) => sum + a.share * (FULL - a.windows[0]!.used), 0);

export interface PoolSummary {
  /** Percent of the whole pool left. */
  remaining: number;
  accounts: number;
}

/** Expects windows already rolled past their resets (the store's snapshot is). */
export function poolSummary(credentials: Credential[], key: string, shares: Map<string, AccountShare>): PoolSummary {
  const accounts = accountsFor(credentials, key, shares);
  return { remaining: remainingOf(accounts), accounts: accounts.length };
}

/** Pool percent `w` can still take before it caps. */
const roomIn = (w: Win) => (w.cost > 0 ? (FULL - w.used) / w.cost : Infinity);
const roomOf = (a: Account) => Math.min(...a.windows.map(roomIn));

/** The proxy's soonest-reset rank: the longest account-wide window's reset, then the shortest's; unknown or past last. */
function resetRank(a: Account, t: number): [number, number] {
  const live = a.windows.filter((w): w is Win & { resetAt: number } => !w.scoped && w.resetAt !== null && w.resetAt > t);
  if (!live.length) return [Infinity, Infinity];
  let long = live[0]!;
  let short = live[0]!;
  for (const w of live) {
    if ((w.durationMs ?? 0) > (long.durationMs ?? 0)) long = w;
    if ((w.durationMs ?? 0) < (short.durationMs ?? 0)) short = w;
  }
  return [long.resetAt, long.durationMs === short.durationMs ? Infinity : short.resetAt];
}

const byId = (x: Account, y: Account) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** Ordered strategies' pick order within one priority tier at `t`; null for rotating strategies. */
function pickOrder(tier: Account[], t: number, strategy: string): Account[] | null {
  if (strategy === FILL_FIRST) return [...tier].sort(byId);
  if (strategy !== SOONEST_RESET) return null;
  const rank = new Map(tier.map((a) => [a, resetRank(a, t)]));
  return [...tier].sort((x, y) => {
    const [xl, xs] = rank.get(x)!;
    const [yl, ys] = rank.get(y)!;
    return xl - yl || xs - ys || byId(x, y);
  });
}

/** Adds use to one account's windows and returns what it took. An unused window with no reset starts on this use. */
function take(a: Account, want: number, t: number): number {
  const got = Math.min(roomOf(a), want);
  if (got <= 0) return 0;
  for (const w of a.windows) {
    if (w.cost === 0) continue;
    if (w.used === 0 && w.resetAt === null && w.durationMs !== null) w.resetAt = t + w.durationMs;
    // The capping window lands on exactly FULL, so rounding cannot leave a sliver of room.
    w.used = got === roomIn(w) ? FULL : w.used + got * w.cost;
  }
  return got;
}

/** Spreads `amount` over a tier in proportion to `share`, passing a capped account's leftover on. */
function split(tier: Account[], amount: number, t: number, share: (a: Account) => number): number {
  const byRoom = [...tier].sort((x, y) => roomOf(x) / share(x) - roomOf(y) / share(y));
  let shares = byRoom.reduce((sum, a) => sum + share(a), 0);
  for (const a of byRoom) {
    amount -= take(a, (amount * share(a)) / shares, t);
    shares -= share(a);
  }
  return amount;
}

/**
 * Spends `amount` as the proxy routes: preferred account first, then highest priority tier with
 * room. Rotating strategies spread it over the tier (by weight if weighted). Benched accounts get none.
 */
function spend(accounts: Account[], amount: number, t: number, strategy: string): void {
  const weighted = strategy === WEIGHTED_ROUND_ROBIN;
  let open = accounts.filter((a) => roomOf(a) > 0 && (a.cooldownUntil === null || a.cooldownUntil <= t));
  const preferred = open.find((a) => a.preferred);
  if (preferred) {
    amount -= take(preferred, amount, t);
    open = open.filter((a) => a !== preferred);
  }
  if (weighted) open = open.filter((a) => a.weight > 0);
  const tiers = [...new Set(open.map((a) => a.priority))].sort((x, y) => y - x);
  for (const priority of tiers) {
    if (amount <= 0) return;
    const tier = open.filter((a) => a.priority === priority);
    const order = pickOrder(tier, t, strategy);
    if (order) for (const a of order) amount -= take(a, amount, t);
    else amount = split(tier, amount, t, (a) => (weighted ? a.weight : 1));
  }
}

/** Pool use until the next routed account caps; split there so exhaustion has its own time. */
function exhaustionBudget(accounts: Account[], t: number, strategy: string): number {
  let open = accounts.filter((a) => roomOf(a) > 0 && (a.cooldownUntil === null || a.cooldownUntil <= t));
  const preferred = open.find((a) => a.preferred);
  if (preferred) return roomOf(preferred);
  const weighted = strategy === WEIGHTED_ROUND_ROBIN;
  if (weighted) open = open.filter((a) => a.weight > 0);
  const priority = Math.max(...open.map((a) => a.priority));
  const tier = open.filter((a) => a.priority === priority);
  const order = pickOrder(tier, t, strategy);
  if (order?.length) return roomOf(order[0]!);
  const weight = (a: Account) => weighted ? a.weight : 1;
  const total = tier.reduce((sum, a) => sum + weight(a), 0);
  return Math.min(...tier.map((a) => roomOf(a) * total / weight(a)));
}

/** Refills every window whose reset is due by `t`; returns the pool percent restored and the first reset. */
function applyResets(accounts: Account[], t: number): { restored: number; firstAt: number } {
  let restored = 0;
  let firstAt = Infinity;
  for (const a of accounts) {
    a.windows.forEach((w, i) => {
      if (w.resetAt === null || w.resetAt > t) return;
      if (i === 0) {
        restored += a.share * w.used;
        firstAt = Math.min(firstAt, w.resetAt);
      }
      w.used = 0;
      w.resetAt = nextResetAfter(w, w.resetAt, t);
    });
  }
  return { restored, firstAt };
}

export interface AccountForecast {
  /** When the projected window reaches 100%; null unless before its next reset. */
  runsOutAt: number | null;
  /** Used percent just before the next reset, capped at 100. */
  endsAtPercent: number;
}

/** Provider-wide outage; project returns null unless every enabled credential is included in the projected accounts. */
export interface PoolStuck {
  /** First time routing cannot place all use. */
  at: number;
  /** First time an account can take use again, within the simulated span. */
  until: number | null;
}

export interface Projection {
  points: SeriesPoint[];
  /** First upcoming reset and the pool percent it restores. */
  nextReset: { at: number; restores: number } | null;
  accounts: Map<string, AccountForecast>;
  stuck: PoolStuck | null;
}

/** Projects steady drain through the proxy router; account forecasts cover their current windows. */
export function project(
  credentials: Credential[], key: string, perHour: number, now: number, hours: number, strategy: string, shares: Map<string, AccountShare>,
): Projection {
  const accounts = accountsFor(credentials, key, shares);
  const end = now + hours * HOUR_MS;
  const points: SeriesPoint[] = [{ t: now, remaining: remainingOf(accounts) }];
  const forecasts = new Map(accounts.map((a) => [a.id, { runsOutAt: a.windows[0]!.used >= FULL ? now : null, endsAtPercent: a.windows[0]!.used }]));
  const deadlines = new Map(accounts.map((a) => [a.id, a.windows[0]!.resetAt]));
  const limit = now + MAX_SIMULATION_MS;
  // Unknown deadlines stay bounded; on-use windows acquire their deadline when first used.
  const horizon = () => Math.min(limit, Math.max(now, ...[...deadlines.values()].map((v) => v ?? limit)));
  let nextReset: Projection['nextReset'] = null;
  let stuck: PoolStuck | null = null;
  const canUse = (t: number) => accounts.some((a) => roomOf(a) > 0 && (a.cooldownUntil === null || a.cooldownUntil <= t)
    && (strategy !== WEIGHTED_ROUND_ROBIN || a.weight > 0 || a.preferred));
  if (accounts.length && !canUse(now)) stuck = { at: now, until: null };
  let t = now;
  while (t < Math.max(end, horizon()) || (stuck && stuck.until === null && t < limit)) {
    const chartStep = now + (Math.floor((t - now) / STEP_MS) + 1) * STEP_MS;
    const events = accounts.flatMap((a) => [a.cooldownUntil, ...a.windows.map((w) => w.resetAt)])
      .filter((v): v is number => v !== null && v > t);
    const boundary = Math.min(chartStep, ...events, t < horizon() ? horizon() : Infinity);
    const budget = perHour > 0 ? exhaustionBudget(accounts, t, strategy) : Infinity;
    const exhaustion = perHour > 0 ? t + budget * HOUR_MS / perHour : Infinity;
    const next = Math.min(boundary, Math.max(t + 1, exhaustion));
    // Eligibility and reset ranking belong to the interval before the event.
    spend(accounts, exhaustion <= next ? budget : perHour * (next - t) / HOUR_MS, t, strategy);
    for (const a of accounts) {
      if (deadlines.get(a.id) === null && a.windows[0]!.resetAt !== null) deadlines.set(a.id, a.windows[0]!.resetAt);
      const deadline = deadlines.get(a.id);
      if (t >= (deadline ?? limit)) continue;
      const forecast = forecasts.get(a.id)!;
      forecast.endsAtPercent = a.windows[0]!.used;
      if (forecast.runsOutAt === null && a.windows[0]!.used >= FULL && next < (deadline ?? limit)) forecast.runsOutAt = next;
    }
    const exhausted = !canUse(t);
    const { restored, firstAt } = applyResets(accounts, next);
    if (next <= end && restored > 0 && !nextReset) nextReset = { at: firstAt, restores: restored };
    if (!stuck && next < horizon() && perHour > 0 && exhausted && !canUse(next)) stuck = { at: next, until: null };
    if (stuck && stuck.until === null && next <= limit && canUse(next)) stuck.until = next;
    if (next === chartStep && next <= end) points.push({ t: next, remaining: remainingOf(accounts) });
    t = next;
  }
  return { points, nextReset, accounts: forecasts, stuck: credentials.every((c) => c.disabled || forecasts.has(c.id)) ? stuck : null };
}
