import { tokenCost } from './modelPrices';
import type { ActivityCounts, ActivityEvent } from './types';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const LOCAL_NOON_HOUR = 12;

/** Floors the local hour using this instant's offset, preserving repeated DST hours. */
export function localHourStart(t: number): number {
  const offset = new Date(t).getTimezoneOffset() * MINUTE_MS;
  return Math.floor((t - offset) / HOUR_MS) * HOUR_MS + offset;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Local calendar day, YYYY-MM-DD, so days match the user's clock. */
export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A whole local day prices at local noon, which lands on the same UTC date for normal offsets. */
export function localNoon(day: string): number {
  const noon = new Date(`${day}T00:00:00`);
  noon.setHours(LOCAL_NOON_HOUR);
  return noon.getTime();
}

export const emptyCounts = (): ActivityCounts => ({
  requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
  costUsd: 0, uncachedCostUsd: 0, unpricedRequests: 0,
  latencyCount: 0, latencySumMs: 0, ttftCount: 0, ttftSumMs: 0,
  ...emptyDetail(),
});
/** Share fields (#155): kept in totals going forward, so older totals have zeros and coverage starts with them. */
function emptyDetail() {
  return { detailRequests: 0, detailCostUsd: 0, thinkingTokens: 0, thinkingOutputTokens: 0,
    fastRequests: 0, flexRequests: 0, fastCostUsd: 0, flexCostUsd: 0, failedCostUsd: 0 };
}
export const DETAIL_KEYS = Object.keys(emptyDetail()) as (keyof ReturnType<typeof emptyDetail>)[];
/** Detail fields that are parts of `costUsd`; they scale with it when a recorded cost replaces the repriced one. */
export const DETAIL_COST_KEYS = ['detailCostUsd', 'fastCostUsd', 'flexCostUsd', 'failedCostUsd'] as const;
const COUNT_KEYS = Object.keys(emptyCounts()) as (keyof ActivityCounts)[];

/** Adds one request, priced on its own so long-prompt rates apply. */
export function addEvent(row: ActivityCounts, e: ActivityEvent & Partial<Pick<ActivityCounts, 'latencyCount' | 'latencySumMs' | 'ttftCount' | 'ttftSumMs'>>): void {
  row.requests += 1;
  row.failed += e.failed ? 1 : 0;
  row.inputTokens += e.inputTokens;
  row.outputTokens += e.outputTokens;
  row.cachedTokens += e.cachedTokens;
  row.cacheWriteTokens += e.cacheWriteTokens;
  if (!e.failed && e.source !== 'client-log') {
    const latency = Number.isFinite(e.latencyMs) && e.latencyMs! > 0;
    const ttft = Number.isFinite(e.ttftMs) && e.ttftMs! > 0;
    row.latencyCount += e.latencyCount ?? (latency ? 1 : 0);
    row.latencySumMs += e.latencySumMs ?? (latency ? e.latencyMs! : 0);
    row.ttftCount += e.ttftCount ?? (ttft ? 1 : 0);
    row.ttftSumMs += e.ttftSumMs ?? (ttft ? e.ttftMs! : 0);
  }
  const cost = tokenCost(e.provider, e.effectiveModel ?? e.model, e.at, e);
  if (cost) {
    row.costUsd += cost.usd;
    row.uncachedCostUsd += cost.uncachedUsd;
  } else row.unpricedRequests += 1;
  const usd = cost?.usd ?? 0;
  row.detailRequests += 1;
  row.detailCostUsd += usd;
  if (typeof e.thinkingTokens === 'number' && Number.isFinite(e.thinkingTokens)) {
    row.thinkingTokens += e.thinkingTokens;
    row.thinkingOutputTokens += e.outputTokens;
  }
  if (e.tier === 'fast') { row.fastRequests += 1; row.fastCostUsd += usd; }
  if (e.tier === 'flex') { row.flexRequests += 1; row.flexCostUsd += usd; }
  if (e.failed) row.failedCostUsd += usd;
}

/** Scales the detail costs with `costUsd` when a recorded cost (an older price, an import) replaces the one just computed. */
export function scaleDetailCosts(row: ActivityCounts, costUsd: number): void {
  const scale = row.costUsd === 0 ? 0 : costUsd / row.costUsd;
  for (const k of DETAIL_COST_KEYS) row[k] *= scale;
}

export function addCounts(row: ActivityCounts, c: ActivityCounts): void {
  for (const k of COUNT_KEYS) row[k] += c[k] ?? 0;
}

/** Older saved rows lack cache writes and cost; prices them as one batch at standard rates. */
export function withCountsFilled<T extends { provider: string; model: string }>(r: T & Partial<ActivityCounts>, at: string | number): T & ActivityCounts {
  const filled = { ...emptyCounts(), ...r };
  if (r.costUsd === undefined) {
    const cost = tokenCost(r.provider, r.model, at, filled, false);
    filled.costUsd = cost?.usd ?? 0;
    filled.uncachedCostUsd = cost?.uncachedUsd ?? 0;
    filled.unpricedRequests = cost ? 0 : filled.requests;
  }
  return filled;
}
