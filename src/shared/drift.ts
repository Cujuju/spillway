import type { ActivityScope } from './activityScope';
export interface DriftQuery { from: string; to: string; scope: ActivityScope }
export interface DriftDay { day: string; replies: number; failed: number; outputTokens: number; thinkingTokens: number; thinkingKnown: number; noThinking: number; ttftSumMs: number; ttftCount: number; latencySumMs: number; latencyCount: number }
export interface DriftChange { at: string; day: string; kind: 'client-version' | 'settings'; client: string | null; from: string | null; to: string; details: string[] }
export interface DriftSeries { key: string; provider: string; model: string; effort: string | null; replies: number; days: DriftDay[]; changes: DriftChange[] }
export interface DriftReport { from: string; to: string; retainedFrom: string | null; series: DriftSeries[] }
/** Two weeks cover weekday variation. */
export const DRIFT_BASELINE_DAYS = 14;
/** Five days avoid baselines built on isolated samples. */
export const DRIFT_MIN_BASELINE_DAYS = 5;
/** Thirty observations suppress small daily samples. */
export const DRIFT_MIN_DAY_SAMPLES = 30;
/** Iglewicz–Hoaglin modified z-score outlier cutoff. */
export const DRIFT_FLAG_Z = 3.5;
/** A five percent floor stabilizes constant baselines. */
export const DRIFT_MIN_SPREAD_FRACTION = 0.05;
/** Normal-consistent scale for median absolute deviation. */
const MAD_SCALE = 1.4826;
export const DRIFT_METRICS = ['thinkingPerReply', 'outputPerReply', 'noThinkingRate', 'meanTtftMs', 'failureRate'] as const;
export type DriftMetric = typeof DRIFT_METRICS[number];
export const DRIFT_MIN_SPREAD: Record<DriftMetric, number> = {
  // Ten tokens suppress negligible changes in thinking output.
  thinkingPerReply: 10,
  // Ten tokens suppress negligible changes in reply length.
  outputPerReply: 10,
  // One percentage point keeps one no-thinking reply in thirty below the cutoff.
  noThinkingRate: 0.01,
  // One percentage point keeps one failure in thirty below the cutoff.
  failureRate: 0.01,
  // Fifty milliseconds suppress small timing fluctuations.
  meanTtftMs: 50,
};
export function driftValue(day: DriftDay, metric: DriftMetric): number | null {
  const [sum, count] = metric === 'thinkingPerReply' ? [day.thinkingTokens, day.thinkingKnown] : metric === 'outputPerReply' ? [day.outputTokens, day.replies] : metric === 'noThinkingRate' ? [day.noThinking, day.thinkingKnown] : metric === 'meanTtftMs' ? [day.ttftSumMs, day.ttftCount] : [day.failed, day.replies + day.failed];
  return count < DRIFT_MIN_DAY_SAMPLES ? null : sum / count;
}
export interface DriftPoint { day: string; value: number | null; baseline: number | null; low: number | null; high: number | null; z: number | null; flagged: 'up' | 'down' | null }
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
export function driftPoints(days: DriftDay[], metric: DriftMetric): DriftPoint[] {
  const history: number[] = [];
  return days.map((d) => {
    const value = driftValue(d, metric), previous = history.slice(-DRIFT_BASELINE_DAYS);
    const baseline = previous.length >= DRIFT_MIN_BASELINE_DAYS ? median(previous) : null;
    const spread = baseline === null ? null : Math.max(MAD_SCALE * median(previous.map((v) => Math.abs(v - baseline))), Math.abs(baseline) * DRIFT_MIN_SPREAD_FRACTION, DRIFT_MIN_SPREAD[metric]);
    const z = value !== null && baseline !== null && spread ? (value - baseline) / spread : null;
    if (value !== null) history.push(value);
    return { day: d.day, value, baseline, low: baseline !== null && spread !== null ? baseline - DRIFT_FLAG_Z * spread : null, high: baseline !== null && spread !== null ? baseline + DRIFT_FLAG_Z * spread : null, z, flagged: z !== null && Math.abs(z) >= DRIFT_FLAG_Z ? z > 0 ? 'up' : 'down' : null };
  });
}
