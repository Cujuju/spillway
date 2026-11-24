/** Implied pay-as-you-go API dollar value ($ per 100%) of subsidized provider quota windows (#237). */

export const FIVE_HOUR_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 24 * 3_600_000;
export const DAYS_PER_WEEK = 7;
export const DAYS_PER_MONTH = 30;
/** Scales a 7-day weekly bucket to an equivalent 30-day monthly API allowance. */
export const MONTH_FROM_WEEK = DAYS_PER_MONTH / DAYS_PER_WEEK;

export type QuotaBucket = 'fiveHour' | 'weekly';

/** Implied API dollar value ($ per 100% of one quota window) derived from clean no-reset intervals. */
export interface QuotaWindowEstimate {
  /** Spend-weighted estimate: (total matched API $) / (total observed Δ% / 100). */
  usdPerFull: number;
  /** Median of per-interval ($/100%) estimates. */
  medianUsdPerFull: number;
  /** Interquartile range [25th, 75th percentile] of per-interval estimates. */
  iqr: [number, number];
  /** Number of clean no-reset intervals included. */
  intervals: number;
  /** Total percentage points of quota observed across clean intervals. */
  observedPercent: number;
  /** Total API list-price USD matched across clean intervals. */
  observedUsd: number;
  /** Intervals where quota increased with $0 local spend (e.g. another machine or web UI). */
  unmatchedIntervals: number;
}

/** One credential's estimated value for a single quota window. */
export interface QuotaWindowSummary {
  credentialId: string;
  authIndex: string;
  provider: string;
  planLabel: string | null;
  windowKey: string;
  bucket: QuotaBucket;
  scoped: boolean;
  estimate: QuotaWindowEstimate;
}

/** Implied plan bucket values attached to a Compare combination row (#238). */
export interface PlanReach {
  fiveHour: QuotaWindowEstimate | null;
  weekly: QuotaWindowEstimate | null;
  /** 30-day API allowance extrapolated from `weekly` (weekly × 30 / 7); null without a weekly estimate. */
  monthlyUsd: number | null;
  /** Distinct plan labels of contributing accounts (e.g. ["Max 20x"]). */
  plans: string[];
  /** Distinct accounts contributing intervals. */
  accounts: number;
}

export const monthlyFromWeekly = (weeklyUsd: number): number => weeklyUsd * MONTH_FROM_WEEK;

const FABLE_MODEL = /^claude-(?:fable|mythos)/i;
const GEMINI_MODEL = /^gemini/i;
const FIVE_HOUR_KEY = /five_hour|5h|primary/i;
const WEEKLY_KEY = /seven_day|weekly|7d|secondary/i;
const FABLE_WINDOW_KEY = /fable|overage_included/i;
const AG_SUMMARY_GEMINI = /^ag_summary:gemini-/i;
const AG_SUMMARY_3P = /^ag_summary:3p-/i;
const AG_PER_MODEL_KEY = /^ag:/i;

/** Classifies a credential window into a 5-hour or weekly bucket, or null when ignored (e.g. per-model AG duplicates). */
export function windowBucket(provider: string, w: { key: string; durationMs: number | null }): QuotaBucket | null {
  const key = w.key.trim();
  if (provider === 'antigravity') {
    if (AG_PER_MODEL_KEY.test(key)) return null;
    if (key === 'ag_gemini') return 'fiveHour';
    if (key === 'ag_claude') return 'weekly';
  }
  if (w.durationMs === FIVE_HOUR_MS) return 'fiveHour';
  if (w.durationMs === WEEK_MS) return 'weekly';
  if (w.durationMs !== null) return null;
  if (FIVE_HOUR_KEY.test(key)) return 'fiveHour';
  if (WEEKLY_KEY.test(key)) return 'weekly';
  return null;
}

/** True when requests for `model` on `provider` draw from `windowKey`. */
export function windowAppliesToModel(provider: string, windowKey: string, model: string): boolean {
  const m = model.trim().toLowerCase();
  if (provider === 'claude') {
    if (FABLE_WINDOW_KEY.test(windowKey)) return FABLE_MODEL.test(m);
    // General five_hour and seven_day account-wide windows count every Claude model.
    return windowKey === 'five_hour' || windowKey === 'seven_day';
  }
  if (provider === 'antigravity') {
    if (AG_SUMMARY_GEMINI.test(windowKey) || windowKey === 'ag_gemini') return GEMINI_MODEL.test(m);
    if (AG_SUMMARY_3P.test(windowKey) || windowKey === 'ag_claude') return !GEMINI_MODEL.test(m);
    return false;
  }
  if (provider === 'codex') {
    return windowKey === 'primary' || windowKey === 'secondary';
  }
  return true;
}

/** Priority for choosing a model's binding weekly window: a matching model-scoped window beats an account-wide one. */
export function weeklyWindowPriority(provider: string, windowKey: string, model: string): number {
  if (provider === 'claude' && FABLE_MODEL.test(model) && FABLE_WINDOW_KEY.test(windowKey)) return 2;
  if (provider === 'antigravity' && (AG_SUMMARY_GEMINI.test(windowKey) || AG_SUMMARY_3P.test(windowKey))) return 2;
  return 1;
}

/** Combines per-account window estimates into a single per-account weighted summary. */
function combineEstimates(items: readonly { estimate: QuotaWindowEstimate; weight: number }[]): QuotaWindowEstimate | null {
  if (!items.length) return null;
  if (items.length === 1) return items[0]!.estimate;
  const totalWeight = items.reduce((s, x) => s + x.weight, 0);
  if (totalWeight <= 0) return null;
  let usdPerFull = 0, medianUsdPerFull = 0, q25 = 0, q75 = 0;
  let intervals = 0, observedPercent = 0, observedUsd = 0, unmatchedIntervals = 0;
  for (const { estimate: e, weight } of items) {
    const share = weight / totalWeight;
    usdPerFull += e.usdPerFull * share;
    medianUsdPerFull += e.medianUsdPerFull * share;
    q25 += e.iqr[0] * share;
    q75 += e.iqr[1] * share;
    intervals += e.intervals;
    observedPercent += e.observedPercent;
    observedUsd += e.observedUsd;
    unmatchedIntervals += e.unmatchedIntervals;
  }
  return { usdPerFull, medianUsdPerFull, iqr: [q25, q75], intervals, observedPercent, observedUsd, unmatchedIntervals };
}

/** Resolves implied per-account plan reach for one `(provider, model)` combination under the active account scope. */
export function planReachForCombo(
  summaries: readonly QuotaWindowSummary[],
  provider: string,
  model: string,
  authWeights: ReadonlyMap<string, number>,
  allowedAccounts: ReadonlySet<string> | null,
): PlanReach | null {
  const inScope = summaries.filter((s) =>
    s.provider === provider
    && (!allowedAccounts || allowedAccounts.has(s.authIndex))
    && windowAppliesToModel(provider, s.windowKey, model));
  if (!inScope.length) return null;

  const activeAuths = new Set([...authWeights.entries()].filter(([, w]) => w > 0).map(([a]) => a));
  const usedMatches = inScope.filter((s) => activeAuths.has(s.authIndex));
  const pool = usedMatches.length ? usedMatches : inScope;

  const pickBucket = (bucket: QuotaBucket): QuotaWindowSummary[] => {
    const candidates = pool.filter((s) => s.bucket === bucket);
    if (bucket !== 'weekly' || candidates.length <= 1) return candidates;
    const best = new Map<string, QuotaWindowSummary>();
    for (const s of candidates) {
      const prev = best.get(s.credentialId);
      if (!prev || weeklyWindowPriority(provider, s.windowKey, model) > weeklyWindowPriority(provider, prev.windowKey, model)) {
        best.set(s.credentialId, s);
      }
    }
    return [...best.values()];
  };

  const weightOf = (s: QuotaWindowSummary) => {
    const spend = authWeights.get(s.authIndex) ?? 0;
    return usedMatches.length && spend > 0 ? spend : s.estimate.observedPercent;
  };

  const fiveHourItems = pickBucket('fiveHour');
  const weeklyItems = pickBucket('weekly');
  const fiveHour = combineEstimates(fiveHourItems.map((s) => ({ estimate: s.estimate, weight: weightOf(s) })));
  const weekly = combineEstimates(weeklyItems.map((s) => ({ estimate: s.estimate, weight: weightOf(s) })));
  if (!fiveHour && !weekly) return null;

  const contributors = [...fiveHourItems, ...weeklyItems];
  const plans = [...new Set(contributors.map((s) => s.planLabel).filter((p): p is string => Boolean(p)))].sort();
  const accounts = new Set(contributors.map((s) => s.credentialId)).size;
  return { fiveHour, weekly, monthlyUsd: weekly ? monthlyFromWeekly(weekly.usdPerFull) : null, plans, accounts };
}
