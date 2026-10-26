import { tokenCost } from './modelPrices';
import type { ActivityCounts, ActivityEvent } from './types';

export const emptyCounts = (): ActivityCounts => ({
  requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
  costUsd: 0, uncachedCostUsd: 0, unpricedRequests: 0,
});

/** Adds one request, priced on its own so long-prompt rates apply. */
export function addEvent(row: ActivityCounts, e: ActivityEvent): void {
  row.requests += 1;
  row.failed += e.failed ? 1 : 0;
  row.inputTokens += e.inputTokens;
  row.outputTokens += e.outputTokens;
  row.cachedTokens += e.cachedTokens;
  row.cacheWriteTokens += e.cacheWriteTokens;
  const cost = tokenCost(e.provider, e.model, e);
  if (cost) {
    row.costUsd += cost.usd;
    row.uncachedCostUsd += cost.uncachedUsd;
  } else row.unpricedRequests += 1;
}

export function addCounts(row: ActivityCounts, c: ActivityCounts): void {
  for (const k of Object.keys(c) as (keyof ActivityCounts)[]) row[k] += c[k];
}

/** Older saved rows lack cache writes and cost; prices them as one batch at standard rates. */
export function withCountsFilled<T extends { provider: string; model: string }>(r: T & Partial<ActivityCounts>): T & ActivityCounts {
  const filled = { ...emptyCounts(), ...r };
  if (r.costUsd === undefined) {
    const cost = tokenCost(r.provider, r.model, filled, false);
    filled.costUsd = cost?.usd ?? 0;
    filled.uncachedCostUsd = cost?.uncachedUsd ?? 0;
    filled.unpricedRequests = cost ? 0 : filled.requests;
  }
  return filled;
}
