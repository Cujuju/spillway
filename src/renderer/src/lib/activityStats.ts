import type { ActivityMetric } from '@shared/activityBoard';
import { addCounts, emptyCounts } from '@shared/activityCounts';
import { accountKey, clientKey } from '@shared/activityScope';
import { promptTokens } from '@shared/modelPrices';
import type { ActivityBucket, ActivityCounts } from '@shared/types';

export type Metric = ActivityMetric;

export interface Summary extends ActivityCounts {
  /** Tokens the model read, cached or not. */
  promptTokens: number;
  /** Prompt plus output tokens. */
  totalTokens: number;
  /** Share of prompt tokens served from cache; null with no prompt tokens. */
  cacheHitRate: number | null;
}

export function summarize(rows: ActivityBucket[]): Summary {
  const c = emptyCounts();
  let prompt = 0;
  for (const r of rows) {
    addCounts(c, r);
    prompt += promptTokens(r.provider, r);
  }
  return { ...c, promptTokens: prompt, totalTokens: prompt + c.outputTokens, cacheHitRate: prompt > 0 ? c.cachedTokens / prompt : null };
}

export const metricValue = (s: Summary, m: Metric) => (m === 'cost' ? s.costUsd : m === 'tokens' ? s.totalTokens : s.requests);

export interface SeriesPoint {
  start: number;
  end: number;
  summary: Summary;
}

/** Sums rows into the range's buckets; rows before the first bucket are left out. */
export function series(rows: ActivityBucket[], starts: number[], now: number): SeriesPoint[] {
  const groups = starts.map(() => [] as ActivityBucket[]);
  for (const r of rows) {
    if (r.start < starts[0]!) continue;
    let i = starts.length - 1;
    while (i > 0 && starts[i]! > r.start) i--;
    groups[i]!.push(r);
  }
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? now, summary: summarize(groups[i]!) }));
}

export interface ModelRow {
  provider: string;
  model: string;
  summary: Summary;
}

export interface AccountRow {
  provider: string;
  authIndex: string | null;
  summary: Summary;
}

/** Sums rows sharing a key, costliest first, then by tokens; `first` is any row of the group. */
function groupSummaries(rows: ActivityBucket[], keyOf: (r: ActivityBucket) => string): { first: ActivityBucket; summary: Summary }[] {
  const groups = new Map<string, ActivityBucket[]>();
  for (const r of rows) {
    const key = keyOf(r);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()]
    .map((g) => ({ first: g[0]!, summary: summarize(g) }))
    .sort((a, b) => b.summary.costUsd - a.summary.costUsd || b.summary.totalTokens - a.summary.totalTokens);
}

/** Per provider and model, costliest first, then by tokens. */
export const byModel = (rows: ActivityBucket[]): ModelRow[] =>
  groupSummaries(rows, (r) => `${r.provider}|${r.model}`).map(({ first, summary }) => ({ provider: first.provider, model: first.model, summary }));

/** One client's totals in the range. */
export interface ClientRow {
  client: string | null;
  summary: Summary;
}

/** Per client, costliest first, then by tokens. */
export const byClient = (rows: ActivityBucket[]): ClientRow[] =>
  groupSummaries(rows, (r) => clientKey(r.client)).map(({ first, summary }) => ({ client: first.client, summary }));

/** Per account, costliest first, then by tokens. An authIndex belongs to one provider. */
export const byAccount = (rows: ActivityBucket[]): AccountRow[] =>
  groupSummaries(rows, (r) => accountKey(r.authIndex)).map(({ first, summary }) => ({ provider: first.provider, authIndex: first.authIndex, summary }));

/** Hour of day, local clock, for chart and grid labels. */
export const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
