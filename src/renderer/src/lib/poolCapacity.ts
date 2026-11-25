import type { ActivityBucket, Credential, HistorySample, LimitWindow } from '@shared/types';
import { consumedBetween } from '@shared/usageWindows';

/**
 * Account window sizes, in Pro 5-hour sessions, so plans add up. Session size is the plan multiplier,
 * else measured (sessionSizes). Longer windows use each account's measured session-to-window ratio.
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

export interface PoolEvidence {
  /** Cached per-account measured session USD (independent of window account-set normalization). */
  measuredSessionUsd(c: Credential, session: string): number | null;
  /** Cached per-account consumed percent for a window key across the evidence samples. */
  consumed(id: string, key: string): number;
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
function measuredRatio(evidence: PoolEvidence, id: string, session: string, key: string): number | null {
  const s = evidence.consumed(id, session);
  const k = evidence.consumed(id, key);
  return s >= MIN_MEASURED_PERCENT && k >= MIN_MEASURED_PERCENT ? s / k : null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

type TimedSample = { sample: HistorySample; time: number };

/** API cost an account's grouped hourly buckets spent between `from` and `to`, spreading each hour evenly. */
function costBetween(buckets: ReadonlyMap<number, number>, from: number, to: number): number {
  let usd = 0;
  for (const [start, costUsd] of buckets) {
    const overlap = Math.min(to, start + HOUR_MS) - Math.max(from, start);
    if (overlap > 0) usd += (costUsd * overlap) / HOUR_MS;
  }
  return usd;
}

function windowUsage(samples: TimedSample[], id: string, key: string, loggedFrom = -Infinity, measuredUntil = Infinity) {
  let percent = 0;
  let first: TimedSample | undefined;
  let prev: TimedSample | undefined;
  for (const next of samples) {
    const { sample, time } = next;
    const used = sample.used[id]?.[key];
    if (used === undefined || time < loggedFrom || time > measuredUntil) continue;
    if (prev) {
      const reset = prev.sample.resets?.[id]?.[key];
      // The missing-next-reset case uses the parsed timestamp instead of parsing again.
      if (reset !== undefined && sample.resets?.[id]?.[key] === undefined) {
        percent += reset <= time ? used : Math.max(0, used - prev.sample.used[id]![key]!);
      } else {
        percent += consumedBetween(prev.sample, sample, id, key) ?? 0;
      }
    }
    first ??= next;
    prev = next;
  }
  return { percent, from: first?.time ?? 0, to: prev?.time ?? 0 };
}

export function preparePoolEvidence(samples: HistorySample[], buckets: ActivityBucket[], measuredUntil = Infinity): PoolEvidence {
  const sorted = samples.map((sample) => ({ sample, time: Date.parse(sample.at) }));
  if (sorted.some(({ time }, i) => i > 0 && time < sorted[i - 1]!.time)) sorted.sort((a, b) => a.time - b.time);

  let loggedFrom = Infinity;
  const hourly = new Map<ActivityBucket['authIndex'], Map<number, number>>();
  for (const b of buckets) {
    if (b.wholeDay) continue;
    loggedFrom = Math.min(loggedFrom, b.start);
    const hours = hourly.get(b.authIndex) ?? new Map<number, number>();
    hours.set(b.start, (hours.get(b.start) ?? 0) + b.costUsd);
    hourly.set(b.authIndex, hours);
  }

  const sessions = new Map<string, number | null>();
  const windows = new Map<string, number>();
  return {
    measuredSessionUsd(c, session) {
      const key = `${c.authIndex}\0${c.id}\0${session}`;
      const cached = sessions.get(key);
      if (cached !== undefined) return cached;
      let result = null;
      const mine = hourly.get(c.authIndex);
      if (mine) {
        const { percent, from, to } = windowUsage(sorted, c.id, session, loggedFrom, measuredUntil);
        if (percent >= MIN_SIZED_PERCENT) {
          // Consecutive readings partition one span, so scan the account's buckets once for its total cost.
          const usd = costBetween(mine, from, to);
          if (usd > 0) result = (usd / percent) * FULL;
        }
      }
      sessions.set(key, result);
      return result;
    },
    consumed(id, key) {
      const cacheKey = `${id}\0${key}`;
      const cached = windows.get(cacheKey);
      if (cached !== undefined) return cached;
      const { percent } = windowUsage(sorted, id, key);
      windows.set(cacheKey, percent);
      return percent;
    },
  };
}

/**
 * API-cost dollars a session window holds: logged cost over how far the window moved. Null below
 * MIN_SIZED_PERCENT. Use outside the proxy moves the window without cost, so it reads low.
 */
export function measuredSessionUsd(samples: HistorySample[], buckets: ActivityBucket[], c: Credential, session: string): number | null {
  return preparePoolEvidence(samples, buckets).measuredSessionUsd(c, session);
}

/**
 * Session window size per account, in Pro sessions: the plan multiple, else measured dollars over
 * the known-plan accounts' dollars per Pro session. Otherwise Pro-sized.
 */
export function sessionSizes(samples: HistorySample[], buckets: ActivityBucket[], accounts: Credential[]): Map<string, number> {
  return sizesFromEvidence(accounts, preparePoolEvidence(samples, buckets));
}

function sizesFromEvidence(accounts: Credential[], evidence: PoolEvidence): Map<string, number> {
  const usd = new Map(accounts.map((c) => {
    const session = sessionWindow(c);
    return [c.id, session ? evidence.measuredSessionUsd(c, session.key) : null] as const;
  }));
  const multiplier = (c: Credential) => c.plan?.multiplier ?? null;
  const usdPerPro = mean(accounts.flatMap((c) => (multiplier(c) && usd.get(c.id) ? [usd.get(c.id)! / multiplier(c)!] : [])));
  const anyKnown = accounts.some((c) => multiplier(c) !== null);
  const meanUsd = mean(accounts.flatMap((c) => usd.get(c.id) ?? []));
  return new Map(accounts.map((c) => {
    const measured = usd.get(c.id) ?? null;
    if (multiplier(c) !== null) return [c.id, multiplier(c)!];
    if (measured !== null && usdPerPro !== null) return [c.id, measured / usdPerPro];
    // No known plan in the pool: compare measured dollars directly; unmeasured accounts get the mean.
    if (!anyKnown && meanUsd !== null) return [c.id, measured ?? meanUsd];
    return [c.id, UNKNOWN_PLAN_MULTIPLIER];
  }));
}

/**
 * Per-account share of the pool for `key` and the cost of 1 pool-percent in each window.
 * Uses all of `samples` and `buckets`: plans change rarely.
 */
export function poolShares(samples: HistorySample[], credentials: Credential[], key: string, buckets: ActivityBucket[], evidence = preparePoolEvidence(samples, buckets)): Map<string, AccountShare> {
  const accounts = credentials.filter((c) => !c.disabled && c.windows.some((w) => w.key === key && w.usedPercent !== null));
  const measured = new Map<string, Map<string, number>>();
  for (const c of accounts) {
    const session = sessionWindow(c);
    const ratios = new Map<string, number>();
    for (const w of c.windows) {
      const r = session && w.key !== session.key ? measuredRatio(evidence, c.id, session.key, w.key) : null;
      if (r !== null) ratios.set(w.key, r);
    }
    measured.set(c.id, ratios);
  }
  // Own history, else the mean of same-tier accounts, else of all measured accounts.
  const ratioFor = (c: Credential, windowKey: string): number | null => {
    if (windowKey === sessionWindow(c)?.key) return 1;
    const own = measured.get(c.id)!.get(windowKey);
    if (own !== undefined) return own;
    const of = (cs: Credential[]) => mean(cs.flatMap((x) => measured.get(x.id)!.get(windowKey) ?? []));
    return of(accounts.filter((x) => c.plan && x.plan?.tier === c.plan.tier)) ?? of(accounts);
  };
  // For a scoped `key`, other traffic also moves the session window, so its size runs high.
  const session = sizesFromEvidence(accounts, evidence);
  // Unknown ratios keep plan weighting; remaining quota cannot be converted, but exhaustion still blocks use.
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
