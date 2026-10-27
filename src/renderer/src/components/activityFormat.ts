import type { ActivityCounts } from '@shared/types';
import type { Metric, Summary } from '../lib/activityStats';
import { metricValue } from '../lib/activityStats';
import { compactNumber, pct, usd } from '../lib/format';
import type { TipRow } from './ChartTip';

export const METRIC_OPTIONS = [{ value: 'cost', label: 'API cost' }, { value: 'tokens', label: 'Tokens' }, { value: 'requests', label: 'Requests' }] as const;
export const metricLabel = (m: Metric) => METRIC_OPTIONS.find((o) => o.value === m)!.label;

/** API cost; a dash when there were requests but none had a price, since unpriced requests are left out. */
export const costText = (c: Pick<ActivityCounts, 'costUsd' | 'requests' | 'unpricedRequests'>) =>
  c.requests > 0 && c.unpricedRequests === c.requests ? '—' : usd(c.costUsd);
export const formatMetric = (m: Metric) => (s: Summary) => (m === 'cost' ? costText(s) : compactNumber(metricValue(s, m)));
/** Axis labels: "$0", "$0.25", "$12.5", "$1.2K". */
export const axisMetric = (m: Metric) => (v: number) => (m !== 'cost' ? compactNumber(v) : v === 0 ? '$0' : v < 1 ? usd(v) : `$${compactNumber(v)}`);
export const hitRate = (s: Summary) => (s.cacheHitRate === null ? '—' : pct(s.cacheHitRate * 100, 1));
export const savings = (s: Summary) => Math.max(0, s.uncachedCostUsd - s.costUsd);

/** Hover readout for one bucket or cell. */
export const countRows = (s: Summary): TipRow[] => [
  { label: 'API cost', value: costText(s) },
  { label: 'Requests', value: `${s.requests.toLocaleString()}${s.failed ? ` (${s.failed} failed)` : ''}` },
  { label: 'Input', value: compactNumber(s.inputTokens) },
  { label: 'Output', value: compactNumber(s.outputTokens) },
  { label: 'Cache read', value: compactNumber(s.cachedTokens) },
  { label: 'Cache write', value: compactNumber(s.cacheWriteTokens) },
  { label: 'Cache hit rate', value: hitRate(s) },
];
