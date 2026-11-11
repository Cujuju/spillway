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
});
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
