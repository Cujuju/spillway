import { DRIFT_BASELINE_DAYS, DRIFT_METRICS, driftPoints, driftValue, type DriftChange, type DriftDay, type DriftMetric, type DriftPoint, type DriftSeries } from '@shared/drift';
import { compactNumber, pct } from './format';

/** The summary's "recent" window: one week evens out the weekday mix of work. */
export const RECENT_DAYS = 7;

export interface MetricMeta { label: string; help: string; format: (v: number) => string }
const rate = (v: number) => pct(v * 100, 1);
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
export const METRIC_META: Record<DriftMetric, MetricMeta> = {
  thinkingPerReply: { label: 'Thinking per reply', help: 'Mean thinking tokens per reply, over replies that reported a count. A reasoning cut shows here first.', format: compactNumber },
  outputPerReply: { label: 'Output per reply', help: 'Mean output tokens per reply, thinking included.', format: compactNumber },
  noThinkingRate: { label: 'Replies without thinking', help: 'Share of replies that reported zero thinking tokens.', format: rate },
  meanTtftMs: { label: 'Mean first token', help: 'Mean time to first token over successful streamed proxy attempts.', format: seconds },
  failureRate: { label: 'Failure rate', help: 'Share of attempts that failed.', format: rate },
};

const SUM_FIELDS = ['replies', 'failed', 'outputTokens', 'thinkingTokens', 'thinkingKnown', 'noThinking', 'ttftSumMs', 'ttftCount', 'latencySumMs', 'latencyCount'] as const;
/** One pooled day, so a window's value is a ratio of sums rather than a mean of daily ratios. */
export function sumDays(days: DriftDay[]): DriftDay {
  const total = { day: '' } as DriftDay;
  for (const f of SUM_FIELDS) total[f] = days.reduce((n, d) => n + d[f], 0);
  return total;
}

export interface MetricSummary {
  metric: DriftMetric; points: DriftPoint[];
  recent: number | null; before: number | null;
  /** (recent − before) / before; null without both. */
  change: number | null;
  flaggedDays: number; direction: 'up' | 'down' | null;
  /** Some recent day had a baseline to compare with. */
  judged: boolean;
}

export function summarizeMetric(series: DriftSeries, metric: DriftMetric): MetricSummary {
  const points = driftPoints(series.days, metric);
  const recentDays = series.days.slice(-RECENT_DAYS);
  const beforeDays = series.days.slice(-RECENT_DAYS - DRIFT_BASELINE_DAYS, -RECENT_DAYS);
  const recent = driftValue(sumDays(recentDays), metric);
  const before = beforeDays.length ? driftValue(sumDays(beforeDays), metric) : null;
  const recentPoints = points.slice(-RECENT_DAYS);
  const flagged = recentPoints.filter((p) => p.flagged);
  const up = flagged.filter((p) => p.flagged === 'up').length;
  return {
    metric, points, recent, before,
    change: recent !== null && before ? (recent - before) / before : null,
    flaggedDays: flagged.length,
    direction: flagged.length ? (up * 2 >= flagged.length ? 'up' : 'down') : null,
    judged: recentPoints.some((p) => p.baseline !== null),
  };
}

export const summarizeSeries = (s: DriftSeries) => DRIFT_METRICS.map((m) => summarizeMetric(s, m));

export const seriesLabel = (s: Pick<DriftSeries, 'model' | 'effort'>) => `${s.model || 'Unknown model'} · ${s.effort ?? 'unknown effort'}`;

/** Recent changes, newest first: the first suspects for a recent shift. */
export const recentChanges = (s: DriftSeries): DriftChange[] => {
  const first = s.days.at(-RECENT_DAYS)?.day ?? '';
  return s.changes.filter((c) => c.day >= first).sort((a, b) => b.at.localeCompare(a.at));
};

export const changeText = (c: DriftChange) =>
  c.kind === 'client-version' ? `${c.client ?? 'Client'} ${c.from ? `${c.from} → ` : ''}${c.to}` : `${c.client ?? 'Client'} request settings changed`;

export const signedPercent = (fraction: number) => `${fraction > 0 ? '+' : fraction < 0 ? '−' : ''}${pct(Math.abs(fraction) * 100, Math.abs(fraction) < 0.1 ? 1 : 0)}`;

export type Verdict =
  | { tone: 'unknown'; title: string; detail: string }
  | { tone: 'steady' | 'unusual'; title: string; detail: string; flagged: MetricSummary[] };

export function verdict(series: DriftSeries, summaries: MetricSummary[]): Verdict {
  if (!summaries.some((s) => s.judged)) return { tone: 'unknown', title: 'Not enough history yet', detail: 'Each metric needs a few earlier days with enough replies before a day can be judged against its normal range.' };
  const flagged = summaries.filter((s) => s.flaggedDays > 0).sort((a, b) => b.flaggedDays - a.flaggedDays);
  if (!flagged.length) return { tone: 'steady', title: 'Within normal range', detail: `No metric left its normal range in the last ${RECENT_DAYS} days.`, flagged };
  const top = flagged[0]!;
  const what = `${METRIC_META[top.metric].label} ${top.direction === 'up' ? 'rose above' : 'fell below'} its normal range on ${top.flaggedDays} of the last ${RECENT_DAYS} days`;
  const changes = recentChanges(series);
  const suspect = changes.length ? ` Client changes in the same week: ${changes.slice(0, 2).map(changeText).join('; ')}.` : ' No client version or request-settings change in the same week, which points away from the client.';
  return { tone: 'unusual', title: flagged.length > 1 ? `${flagged.length} metrics look unusual` : 'One metric looks unusual', detail: `${what}.${suspect}`, flagged };
}
