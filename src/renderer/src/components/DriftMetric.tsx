import { createMemo, Show } from 'solid-js';
import { DRIFT_BASELINE_DAYS, DRIFT_FLAG_Z, type DriftSeries } from '@shared/drift';
import { dayLabel } from '../lib/format';
import { changeText, METRIC_META, RECENT_DAYS, signedPercent, type MetricSummary } from '../lib/driftView';
import { DriftChart, type DriftMarker } from './DriftChart';
import { InfoTip, type TipRow } from './ChartTip';
import { appLocale } from '@shared/timeFormat';

const CHART_HEIGHT_PX = 150;
const FEATURED_CHART_HEIGHT_PX = 210;
/** Rates read better on a fixed 0–100% scale only when they can plausibly reach it; small rates get a fitted scale. */
const FULL_SCALE_RATE = 0.5;

/** One metric's card: recent value against the weeks before, and the daily chart with its normal range. */
export function DriftMetric(props: { series: DriftSeries; summary: MetricSummary; featured?: boolean }) {
  const meta = () => METRIC_META[props.summary.metric];
  const days = () => props.series.days.map((d) => d.day);
  const markers = createMemo<DriftMarker[]>(() => {
    const index = new Map(days().map((d, i) => [d, i]));
    return props.series.changes.flatMap((c) => (index.has(c.day) ? [{ index: index.get(c.day)!, kind: c.kind }] : []));
  });
  const isRate = () => props.summary.metric === 'noThinkingRate' || props.summary.metric === 'failureRate';
  const yMax = () => (isRate() && props.summary.points.some((p) => (p.value ?? 0) > FULL_SCALE_RATE) ? 1 : undefined);
  const tone = () => (props.summary.flaggedDays ? 'unusual' : props.summary.judged ? 'steady' : 'unknown');

  const tooltip = (i: number): { title: string; rows: TipRow[] } => {
    const p = props.summary.points[i]!;
    const d = props.series.days[i]!;
    const f = meta().format;
    const rows: TipRow[] = [{ label: meta().label, value: p.value === null ? 'Too few replies' : f(p.value) }];
    if (p.baseline !== null) rows.push({ label: 'Baseline', value: f(p.baseline) }, { label: 'Normal range', value: `${f(Math.max(0, p.low!))} – ${f(p.high!)}` });
    if (p.z !== null) rows.push({ label: 'Deviation', value: `${p.z > 0 ? '+' : ''}${p.z.toFixed(1)}σ${p.flagged ? ' · unusual' : ''}` });
    rows.push({ label: 'Replies', value: d.replies.toLocaleString(appLocale()) });
    for (const c of props.series.changes.filter((c) => c.day === d.day)) rows.push({ label: c.kind === 'settings' ? 'Settings' : 'Version', value: changeText(c) });
    return { title: dayLabel(d.day), rows };
  };

  return (
    <section class={`card drift-metric ${tone()}`} classList={{ featured: props.featured }}>
      <header class="drift-metric-head">
        <h3 class="drift-metric-title">{meta().label}</h3>
        <InfoTip title={meta().label} note={meta().help} rows={[
          { label: 'Value', value: `Last ${RECENT_DAYS} days, pooled` },
          { label: 'Compared with', value: `The ${DRIFT_BASELINE_DAYS} days before` },
          { label: 'Normal range', value: `Median of the previous ${DRIFT_BASELINE_DAYS} days ± ${DRIFT_FLAG_Z} robust σ` },
        ]} />
        <Show when={props.summary.flaggedDays}>
          <span class="drift-pill unusual">{props.summary.flaggedDays} unusual {props.summary.flaggedDays === 1 ? 'day' : 'days'}</span>
        </Show>
      </header>
      <div class="drift-metric-figure">
        <span class="drift-metric-value">{props.summary.recent === null ? '—' : meta().format(props.summary.recent)}</span>
        <Show when={props.summary.change !== null} fallback={<span class="drift-metric-sub">Not enough earlier data to compare</span>}>
          <span class="drift-delta" classList={{ up: props.summary.change! > 0, down: props.summary.change! < 0 }}>{signedPercent(props.summary.change!)}</span>
          <span class="drift-metric-sub">vs {meta().format(props.summary.before!)} the {DRIFT_BASELINE_DAYS} days before</span>
        </Show>
      </div>
      <DriftChart days={days()} height={props.featured ? FEATURED_CHART_HEIGHT_PX : CHART_HEIGHT_PX} yMax={yMax()} yLabel={meta().format}
        ariaLabel={`${meta().label} per day`} tooltip={tooltip} markers={markers()}
        lines={[{ label: meta().label, color: 'var(--color-accent)', values: props.summary.points.map((p) => p.value) }]}
        band={{ low: props.summary.points.map((p) => p.low === null ? null : Math.max(0, p.low)), high: props.summary.points.map((p) => p.high), baseline: props.summary.points.map((p) => p.baseline) }}
        flags={props.summary.points.map((p) => p.flagged)} />
    </section>
  );
}
