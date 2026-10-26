import type { ActivityBucket, Credential, HistorySample, LimitWindow } from '@shared/types';
import { consumedBetween } from '@shared/usageWindows';
import { consumed } from './poolHistory';

/**
 * How big each account's limit windows are, so accounts on different plans add up correctly.
 * Sizes are in Pro 5-hour sessions: the session window holds the plan multiplier (Max 5x = 5).
 * A plan without a published multiple (Team, Enterprise, Codex) is measured instead: the API-cost
 * dollars its logged requests spent per 1% of its session window (see sessionSizes).
 * Longer windows don't scale by the same multiple, so each account's own history measures them:
 * the session percent it used per 1% of the window.
 */

/** Plan size when the proxy reports none (other providers, older proxies, Team): Pro-sized. */
const UNKNOWN_PLAN_MULTIPLIER = 1;
/** Both windows must have moved this many percent before a ratio counts; whole-percent readings keep its error near 20% or less. */
const MIN_MEASURED_PERCENT = 5;
/** Session percent an account must move while requests are logged before its size counts; keeps whole-percent rounding near 5%. */
const MIN_SIZED_PERCENT = 20;
const HOUR_MS = 3_600_000;
const FULL = 100;

export interface AccountShare {
  /** Fraction of the pool's capacity for the pooled window; shares sum to 1. */
  share: number;
  /** Account percent of each window used per 1% of the pool. */
  cost: Record<string, number>;
}

/** The account's session window: its shortest account-wide window with a known length. */
function sessionWindow(c: Credential): LimitWindow | null {
  let best: LimitWindow | null = null;
  for (const w of c.windows) {
    if (w.scoped || w.durationMs === null) continue;
    if (!best || w.durationMs < best.durationMs!) best = w;
  }
  return best;
}

/** Session percent per 1% of `key` on one account, or null when history is too thin. */
function measuredRatio(samples: HistorySample[], id: string, session: string, key: string): number | null {
  const s = consumed(samples, [id], session);
  const k = consumed(samples, [id], key);
  return s >= MIN_MEASURED_PERCENT && k >= MIN_MEASURED_PERCENT ? s / k : null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** API cost an account's hourly buckets spent between `from` and `to`, spreading each hour evenly. */
function costBetween(buckets: ActivityBucket[], from: number, to: number): number {
  let usd = 0;
  for (const b of buckets) {
    const overlap = Math.min(to, b.start + HOUR_MS) - Math.max(from, b.start);
    if (overlap > 0) usd += (b.costUsd * overlap) / HOUR_MS;
  }
  return usd;
}

/**
 * API-cost dollars a full session window holds, from the account's logged requests and how far
 * its session window moved meanwhile; null until it has moved MIN_SIZED_PERCENT while logged.
 * Use outside the proxy (claude.ai, another machine) moves the window without logged cost, so
 * the size reads low.
 */
export function measuredSessionUsd(samples: HistorySample[], buckets: ActivityBucket[], c: Credential, session: string): number | null {
  const hourly = buckets.filter((b) => !b.wholeDay);
  if (!hourly.length) return null;
  const loggedFrom = Math.min(...hourly.map((b) => b.start));
  const mine = hourly.filter((b) => b.authIndex === c.authIndex);
  let usd = 0;
  let percent = 0;
  let prev: HistorySample | undefined;
  for (const s of samples) {
    if (s.used[c.id]?.[session] === undefined || Date.parse(s.at) < loggedFrom) continue;
    if (prev) {
      percent += consumedBetween(prev, s, c.id, session) ?? 0;
      usd += costBetween(mine, Date.parse(prev.at), Date.parse(s.at));
    }
    prev = s;
  }
  return percent >= MIN_SIZED_PERCENT && usd > 0 ? (usd / percent) * FULL : null;
}

/**
 * Session window size per account, in Pro sessions when any plan is known. A published plan
 * multiple wins. Otherwise a measured size is converted with the dollars per Pro session that
 * known-plan accounts in the pool measured. A pool with no known plan compares measured dollars
 * directly, giving unmeasured accounts the mean. Anything else counts as Pro-sized.
 */
export function sessionSizes(samples: HistorySample[], buckets: ActivityBucket[], accounts: Credential[]): Map<string, number> {
  const usd = new Map(accounts.map((c) => {
    const session = sessionWindow(c);
    return [c.id, session ? measuredSessionUsd(samples, buckets, c, session.key) : null] as const;
  }));
  const multiplier = (c: Credential) => c.plan?.multiplier ?? null;
  const usdPerPro = mean(accounts.flatMap((c) => (multiplier(c) && usd.get(c.id) ? [usd.get(c.id)! / multiplier(c)!] : [])));
  const anyKnown = accounts.some((c) => multiplier(c) !== null);
  const meanUsd = mean(accounts.flatMap((c) => usd.get(c.id) ?? []));
  return new Map(accounts.map((c) => {
    const measured = usd.get(c.id) ?? null;
    if (multiplier(c) !== null) return [c.id, multiplier(c)!];
    if (measured !== null && usdPerPro !== null) return [c.id, measured / usdPerPro];
    if (!anyKnown && meanUsd !== null) return [c.id, measured ?? meanUsd];
    return [c.id, UNKNOWN_PLAN_MULTIPLIER];
  }));
}

/**
 * Per-account share of the pool for `key` and the cost of 1 pool-percent in each window.
 * A window's ratio comes from the account's own history, else the mean of accounts on the same
 * tier, else the mean of all measured accounts. With none, shares assume the window scales with
 * the plan, and the window gets no cost, so it does not cap the forecast.
 * Uses all of `samples` and `buckets` (logged requests, for plans without a published size): plans change rarely. For a scoped `key`, other traffic also moves the
 * session window, so its size runs high.
 */
export function poolShares(samples: HistorySample[], credentials: Credential[], key: string, buckets: ActivityBucket[]): Map<string, AccountShare> {
  const accounts = credentials.filter((c) => !c.disabled && c.windows.some((w) => w.key === key && w.usedPercent !== null));
  const measured = new Map<string, Map<string, number>>();
  for (const c of accounts) {
    const session = sessionWindow(c);
    const ratios = new Map<string, number>();
    for (const w of c.windows) {
      const r = session && w.key !== session.key ? measuredRatio(samples, c.id, session.key, w.key) : null;
      if (r !== null) ratios.set(w.key, r);
    }
    measured.set(c.id, ratios);
  }
  const ratioFor = (c: Credential, windowKey: string): number | null => {
    if (windowKey === sessionWindow(c)?.key) return 1;
    const own = measured.get(c.id)!.get(windowKey);
    if (own !== undefined) return own;
    const of = (cs: Credential[]) => mean(cs.flatMap((x) => measured.get(x.id)!.get(windowKey) ?? []));
    return of(accounts.filter((x) => c.plan && x.plan?.tier === c.plan.tier)) ?? of(accounts);
  };
  const session = sessionSizes(samples, buckets, accounts);
  const sizes = new Map(accounts.map((c) => {
    const multiplier = session.get(c.id)!;
    return [c.id, new Map(c.windows.map((w) => {
      const ratio = ratioFor(c, w.key);
      return [w.key, { size: multiplier * (ratio ?? 1), known: ratio !== null }] as const;
    }))] as const;
  }));
  const total = accounts.reduce((sum, c) => sum + sizes.get(c.id)!.get(key)!.size, 0);
  return new Map(accounts.map((c) => {
    const size = sizes.get(c.id)!;
    // Two windows cap each other only when both sizes are measured against the session window.
    const keyKnown = size.get(key)!.known;
    const cost = [...size].filter(([k, x]) => k === key || (keyKnown && x.known)).map(([k, x]) => [k, total / x.size] as const);
    return [c.id, { share: size.get(key)!.size / total, cost: Object.fromEntries(cost) }];
  }));
}
