import { localDay } from '@shared/activityCounts';
import { quantile } from '@shared/activityCompare';
import { tokenCost } from '@shared/modelPrices';
import {
  windowAppliesToModel,
  windowBucket,
  type QuotaWindowEstimate,
  type QuotaWindowSummary,
} from '@shared/quotaValue';
export { planReachForCombo } from '@shared/quotaValue';
import type { HistorySample } from '@shared/types';
import { resetBetween } from '@shared/usageWindows';
import type { Db } from './activityDb';

const PERCENT_SCALE = 100;
/** Cap saturation: crossing into 100% can clamp true consumption and overstate $/100%. */
const FULL_PERCENT = 100;
/** Ignores sub-0.01% floating-point noise in repeated fractional quota readings. */
const MIN_ATOMIC_DELTA_PERCENT = 0.01;
/** Smallest fractional interval kept for median/IQR (Antigravity reports fractional percent). */
const MIN_FRACTIONAL_INTERVAL_PERCENT = 0.5;
/** Coalesces 1% integer ticks (Claude, Codex) so endpoint rounding stays bounded. */
const MIN_INTEGER_INTERVAL_PERCENT = 2;
/** Minimum total observed percent required before publishing a bucket estimate. */
const MIN_OBSERVED_PERCENT = 1;
/** Without reset timestamps (legacy samples), gaps wider than 2 hours may conceal a reset. */
const MAX_UNTRACKED_RESET_GAP_MS = 2 * 3_600_000;
const Q25 = 0.25;
const Q50 = 0.5;
const Q75 = 0.75;

export interface QuotaCredentialContext {
  id: string;
  authIndex: string;
  provider: string;
  planLabel: string | null;
  windows: { key: string; durationMs: number | null; scoped: boolean }[];
}

export interface QuotaContext {
  samples: HistorySample[];
  credentials: QuotaCredentialContext[];
}

interface SpendEvent {
  atMs: number;
  provider: string;
  model: string;
  costUsd: number | null;
}

interface RawRequestRow {
  at: string | null;
  authIndex: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  cacheWriteLongTokens: number | null;
  tier: string | null;
}

/** First index with `events[i].atMs > targetMs` (upper bound). */
function firstAfter(events: readonly SpendEvent[], targetMs: number): number {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.atMs <= targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Oldest local day held in `requests`, or null when empty. Pruning drops whole days, so every day >= this is unpruned. */
function oldestRetainedDay(db: Db): string | null {
  return (db.prepare('SELECT min(day) AS day FROM requests').get() as { day: string | null }).day;
}

/** Loads retained request costs in `[fromMs, toMs]` indexed by `authIndex` and sorted by timestamp. */
function loadSpendByAuth(db: Db, fromMs: number, toMs: number, authIndices: ReadonlySet<string>): Map<string, SpendEvent[]> {
  const byAuth = new Map<string, SpendEvent[]>();
  if (authIndices.size === 0 || fromMs > toMs) return byAuth;
  const sql = `SELECT
    json_extract(event, '$.at') AS at,
    json_extract(event, '$.authIndex') AS authIndex,
    json_extract(event, '$.provider') AS provider,
    coalesce(json_extract(event, '$.effectiveModel'), json_extract(event, '$.model')) AS model,
    json_extract(event, '$.costUsd') AS costUsd,
    json_extract(event, '$.inputTokens') AS inputTokens,
    json_extract(event, '$.outputTokens') AS outputTokens,
    json_extract(event, '$.cachedTokens') AS cachedTokens,
    json_extract(event, '$.cacheWriteTokens') AS cacheWriteTokens,
    json_extract(event, '$.cacheWrite1hTokens') AS cacheWrite1hTokens,
    json_extract(event, '$.cacheWriteLongTokens') AS cacheWriteLongTokens,
    json_extract(event, '$.tier') AS tier
    FROM requests WHERE day >= ? AND day <= ?`;
  const rows = db.prepare(sql).all(localDay(fromMs), localDay(toMs)) as RawRequestRow[];
  for (const r of rows) {
    if (!r.authIndex || !authIndices.has(r.authIndex) || !r.at || !r.provider || !r.model) continue;
    const atMs = Date.parse(r.at);
    if (!Number.isFinite(atMs) || atMs < fromMs || atMs > toMs) continue;
    const tier = r.tier === 'fast' || r.tier === 'flex' || r.tier === 'standard' ? r.tier : null;
    const costUsd = typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)
      ? r.costUsd
      : tokenCost(r.provider, r.model, r.at, {
          inputTokens: r.inputTokens ?? 0,
          outputTokens: r.outputTokens ?? 0,
          cachedTokens: r.cachedTokens ?? 0,
          cacheWriteTokens: r.cacheWriteTokens ?? 0,
          cacheWrite1hTokens: r.cacheWrite1hTokens,
          cacheWriteLongTokens: r.cacheWriteLongTokens,
          tier,
        })?.usd ?? null;
    let list = byAuth.get(r.authIndex);
    if (!list) { list = []; byAuth.set(r.authIndex, list); }
    list.push({ atMs, provider: r.provider, model: r.model, costUsd });
  }
  for (const list of byAuth.values()) list.sort((a, b) => a.atMs - b.atMs);
  return byAuth;
}

/** Sums matching API spend in `(fromMs, toMs]`; flags unpriced requests so they do not understate $/100%. */
function intervalSpend(events: readonly SpendEvent[], provider: string, windowKey: string, fromMs: number, toMs: number): { usd: number; unpriced: boolean } {
  let usd = 0;
  let unpriced = false;
  for (let i = firstAfter(events, fromMs); i < events.length && events[i]!.atMs <= toMs; i++) {
    const e = events[i]!;
    if (e.provider !== provider || !windowAppliesToModel(provider, windowKey, e.model)) continue;
    if (e.costUsd === null) { unpriced = true; continue; }
    usd += e.costUsd;
  }
  return { usd, unpriced };
}

interface CleanInterval { delta: number; usd: number }

/** Estimates one credential window's $/100% from clean, no-reset transitions against retained requests. */
function estimateWindow(
  samples: readonly { atMs: number; day: string; sample: HistorySample }[],
  cred: QuotaCredentialContext,
  windowKey: string,
  events: readonly SpendEvent[],
  oldestDay: string,
): QuotaWindowEstimate | null {
  let anchor: { atMs: number; day: string; sample: HistorySample; used: number } | null = null;
  let runDelta = 0;
  let runUsd = 0;
  let unmatchedIntervals = 0;
  const intervals: CleanInterval[] = [];

  const flushRun = (minDelta: number) => {
    if (runDelta >= minDelta && runUsd > 0) intervals.push({ delta: runDelta, usd: runUsd });
    runDelta = 0;
    runUsd = 0;
  };

  for (const entry of samples) {
    const used = entry.sample.used[cred.id]?.[windowKey];
    if (used === undefined || !Number.isFinite(used)) continue;
    if (!anchor) {
      anchor = { ...entry, used };
      continue;
    }
    const crossedReset = resetBetween(anchor.sample, entry.sample, cred.id, windowKey) || used < anchor.used;
    const untrackedWideGap = anchor.used > 0 && anchor.sample.resets?.[cred.id]?.[windowKey] === undefined && entry.atMs - anchor.atMs > MAX_UNTRACKED_RESET_GAP_MS;
    if (crossedReset || untrackedWideGap) {
      flushRun(MIN_FRACTIONAL_INTERVAL_PERCENT);
      anchor = { ...entry, used };
      continue;
    }
    const delta = used - anchor.used;
    if (delta < MIN_ATOMIC_DELTA_PERCENT) continue;
    // Skip transitions before retained request days or capped at 100%, advancing the anchor cleanly.
    if (anchor.day < oldestDay || used >= FULL_PERCENT) {
      flushRun(MIN_FRACTIONAL_INTERVAL_PERCENT);
      anchor = { ...entry, used };
      continue;
    }
    const { usd, unpriced } = intervalSpend(events, cred.provider, windowKey, anchor.atMs, entry.atMs);
    anchor = { ...entry, used };
    if (unpriced) {
      flushRun(MIN_FRACTIONAL_INTERVAL_PERCENT);
      continue;
    }
    if (usd <= 0) {
      unmatchedIntervals += 1;
      flushRun(MIN_FRACTIONAL_INTERVAL_PERCENT);
      continue;
    }
    runDelta += delta;
    runUsd += usd;
    const targetDelta = Number.isInteger(used) && Number.isInteger(delta) ? MIN_INTEGER_INTERVAL_PERCENT : MIN_FRACTIONAL_INTERVAL_PERCENT;
    if (runDelta >= targetDelta) flushRun(targetDelta);
  }
  flushRun(MIN_FRACTIONAL_INTERVAL_PERCENT);

  const observedPercent = intervals.reduce((s, iv) => s + iv.delta, 0);
  const observedUsd = intervals.reduce((s, iv) => s + iv.usd, 0);
  if (!intervals.length || observedPercent < MIN_OBSERVED_PERCENT || observedUsd <= 0) return null;

  const rates = intervals.map((iv) => (iv.usd / iv.delta) * PERCENT_SCALE).sort((a, b) => a - b);
  return {
    usdPerFull: (observedUsd / observedPercent) * PERCENT_SCALE,
    medianUsdPerFull: quantile(rates, Q50),
    iqr: [quantile(rates, Q25), quantile(rates, Q75)],
    intervals: intervals.length,
    observedPercent,
    observedUsd,
    unmatchedIntervals,
  };
}

/** Computes implied API dollar values ($/100%) for every observed 5-hour and weekly credential window. */
export function estimateQuotaWindows(db: Db, context: QuotaContext): QuotaWindowSummary[] {
  if (!context.samples.length || !context.credentials.length) return [];
  const oldestDay = oldestRetainedDay(db);
  if (oldestDay === null) return [];

  const sortedSamples = context.samples
    .map((sample) => {
      const atMs = Date.parse(sample.at);
      return { atMs, day: Number.isFinite(atMs) ? localDay(atMs) : '', sample };
    })
    .filter((s) => Number.isFinite(s.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  if (sortedSamples.length < 2) return [];

  const fromMs = sortedSamples[0]!.atMs;
  const toMs = sortedSamples.at(-1)!.atMs;
  if (fromMs >= toMs) return [];

  const authIndices = new Set(context.credentials.map((c) => c.authIndex));
  const spendByAuth = loadSpendByAuth(db, fromMs, toMs, authIndices);
  const results: QuotaWindowSummary[] = [];

  for (const cred of context.credentials) {
    const events = spendByAuth.get(cred.authIndex);
    if (!events?.length) continue;
    for (const w of cred.windows) {
      const bucket = windowBucket(cred.provider, w);
      if (!bucket) continue;
      const estimate = estimateWindow(sortedSamples, cred, w.key, events, oldestDay);
      if (!estimate) continue;
      results.push({
        credentialId: cred.id,
        authIndex: cred.authIndex,
        provider: cred.provider,
        planLabel: cred.planLabel,
        windowKey: w.key,
        bucket,
        scoped: w.scoped,
        estimate,
      });
    }
  }
  return results;
}
