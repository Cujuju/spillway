import type { Credential, HistorySample, LimitWindow } from '@shared/types';
import { consumed } from './poolHistory';

/**
 * How big each account's limit windows are, so accounts on different plans add up correctly.
 * Sizes are in Pro 5-hour sessions: the session window holds the plan multiplier (Max 5x = 5).
 * Longer windows don't scale by the same multiple, so each account's own history measures them:
 * the session percent it used per 1% of the window.
 */

/** Plan size when the proxy reports none (other providers, older proxies, Team): Pro-sized. */
const UNKNOWN_PLAN_MULTIPLIER = 1;
/** Both windows must have moved this many percent before a ratio counts; whole-percent readings keep its error near 20% or less. */
const MIN_MEASURED_PERCENT = 5;

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

/**
 * Per-account share of the pool for `key` and the cost of 1 pool-percent in each window.
 * A window's ratio comes from the account's own history, else the mean of accounts on the same
 * tier, else the mean of all measured accounts. With none, shares assume the window scales with
 * the plan, and the window gets no cost, so it does not cap the forecast.
 * Uses all of `samples`: plans change rarely. For a scoped `key`, other traffic also moves the
 * session window, so its size runs high.
 */
export function poolShares(samples: HistorySample[], credentials: Credential[], key: string): Map<string, AccountShare> {
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
  const sizes = new Map(accounts.map((c) => {
    const multiplier = c.plan?.multiplier ?? UNKNOWN_PLAN_MULTIPLIER;
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
