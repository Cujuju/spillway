import { createMemo, createSignal, For, Show } from 'solid-js';
import {
  bucketStarts, byModel, inRange, metricValue, RANGES, series, summarize, type Metric, type Range, type SeriesPoint, type Summary,
} from '../lib/activityStats';
import { compactNumber, pct, usd } from '../lib/format';
import { activityBuckets, now } from '../store';
import { ActivityHeatmap } from './ActivityHeatmap';
import { TokenCell } from './TokenCell';
import { TrendChart } from './TrendChart';
import { ProviderGlyph, Seg } from './ui';

const USAGE_CHART_PX = 180;
/** The hit rate sits near 100% most of the time; a short chart with 0/50/100% lines is enough. */
const CACHE_CHART_PX = 110;
const CACHE_Y_TICKS = 2;
/** Date the price table in src/shared/modelPrices.ts was checked. */
const PRICES_CHECKED = 'Oct 26, 2026';

const NUMERIC_COLUMNS = ['Requests', 'Input', 'Output', 'Cache read', 'Cache write', 'Cache hit', 'API cost'];
/** Model, the numeric columns, and Share. */
const MODEL_COLUMN_COUNT = NUMERIC_COLUMNS.length + 2;
const RANGE_OPTIONS = [{ value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }] as const;
const METRIC_OPTIONS = [{ value: 'cost', label: 'API cost' }, { value: 'tokens', label: 'Tokens' }, { value: 'requests', label: 'Requests' }] as const;
const BUCKET_NOTE: Record<Range, string> = { '24h': 'Hourly', '7d': 'Every 3 hours', '30d': 'Daily' };

const formatMetric = (m: Metric) => (v: number) => (m === 'cost' ? usd(v) : compactNumber(v));
/** Axis labels: "$0", "$0.25", "$12.5", "$1.2K". */
const axisMetric = (m: Metric) => (v: number) => (m !== 'cost' ? compactNumber(v) : v === 0 ? '$0' : v < 1 ? usd(v) : `$${compactNumber(v)}`);
const hitRate = (s: Summary) => (s.cacheHitRate === null ? '—' : pct(s.cacheHitRate * 100, 1));
const savings = (s: Summary) => Math.max(0, s.uncachedCostUsd - s.costUsd);

/** Hover readout for one bucket or cell: label left, value right. */
function CountsTip(props: { s: Summary }) {
  const rows = () => [
    ['API cost', usd(props.s.costUsd)],
    ['Requests', `${props.s.requests.toLocaleString()}${props.s.failed ? ` (${props.s.failed} failed)` : ''}`],
    ['Input', compactNumber(props.s.inputTokens)],
    ['Output', compactNumber(props.s.outputTokens)],
    ['Cache read', compactNumber(props.s.cachedTokens)],
    ['Cache write', compactNumber(props.s.cacheWriteTokens)],
    ['Cache hit rate', hitRate(props.s)],
  ];
  return <For each={rows()}>{([l, v]) => <div class="tip-row"><span>{l}</span><strong>{v}</strong></div>}</For>;
}

function Stat(props: { label: string; value: string; sub: string; title?: string }) {
  return (
    <div class="stat-cell" title={props.title}>
      <div class="stat-label">{props.label}</div>
      <div class="stat-value">{props.value}</div>
      <div class="stat-sub truncate">{props.sub}</div>
    </div>
  );
}

export function ActivityOverview() {
  const [range, setRange] = createSignal<Range>('7d');
  const [metric, setMetric] = createSignal<Metric>('cost');
  const rows = activityBuckets;

  const starts = createMemo(() => bucketStarts(range(), now()));
  const scoped = createMemo(() => inRange(rows(), starts()));
  const total = createMemo(() => summarize(scoped()));
  const points = createMemo(() => series(scoped(), starts(), now()));
  const models = createMemo(() => byModel(scoped()));
  const unpriced = createMemo(() => models().filter((m) => m.summary.unpricedRequests > 0).map((m) => m.model));
  const daily = () => RANGES[range()].hoursPerBucket >= 24;
  /** "Mon, Oct 26" for a day; "Mon 3 AM" for an hour; "Mon 3 AM – 6 AM" for a multi-hour bar. */
  const bucketLabel = (p: SeriesPoint) => {
    if (daily()) return new Date(p.start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const start = new Date(p.start).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
    return RANGES[range()].hoursPerBucket > 1 ? `${start} – ${new Date(p.end).toLocaleTimeString(undefined, { hour: 'numeric' })}` : start;
  };
  const xLabel = (t: number) => new Date(t).toLocaleString(undefined, daily() || range() === '7d' ? { month: 'numeric', day: 'numeric' } : { hour: 'numeric' });
  const tip = (i: number) => (
    <>
      <div class="tip-title">{bucketLabel(points()[i]!)}</div>
      <CountsTip s={points()[i]!.summary} />
    </>
  );
  const metricLabel = () => METRIC_OPTIONS.find((o) => o.value === metric())!.label;

  return (
    <>
      <div class="toolbar">
        <Seg value={range()} options={RANGE_OPTIONS} onChange={setRange} />
        <span class="spacer" />
        <Seg value={metric()} options={METRIC_OPTIONS} onChange={setMetric} />
      </div>

      <div class="card stat-strip">
        <Stat label="API cost" value={usd(total().costUsd)} sub="at list prices" title="What these requests would cost on the pay-as-you-go API" />
        <Stat label="Tokens" value={compactNumber(total().totalTokens)} sub={`${compactNumber(total().outputTokens)} output`} />
        <Stat label="Requests" value={total().requests.toLocaleString()} sub={`${total().failed.toLocaleString()} failed`} />
        <Stat label="Cache hit" value={hitRate(total())} sub={`${compactNumber(total().cachedTokens)} from cache`} title="Prompt tokens served from the prompt cache" />
        <Stat label="Cache savings" value={usd(savings(total()))} sub="vs. no caching" title="List-price cost with every prompt token uncached, minus the estimate" />
      </div>

      <div class="card">
        <div class="chart-head">
          <div class="section-label">{metricLabel()} over time</div>
          <span class="chart-head-note">{BUCKET_NOTE[range()]}</span>
        </div>
        <TrendChart kind="bar" height={USAGE_CHART_PX} ariaLabel={`${metricLabel()} over time`} points={points().map((p) => ({ start: p.start, value: metricValue(p.summary, metric()) }))}
          yLabel={axisMetric(metric())} xLabel={xLabel} tooltip={tip} />
      </div>
      <div class="card">
        <div class="chart-head">
          <div class="section-label">Cache hit rate</div>
          <span class="chart-head-note">Share of prompt tokens read from cache</span>
        </div>
        <TrendChart kind="line" height={CACHE_CHART_PX} ariaLabel="Cache hit rate over time" yMax={1} yTicks={CACHE_Y_TICKS}
          points={points().map((p) => ({ start: p.start, value: p.summary.cacheHitRate }))} yLabel={(v) => pct(v * 100)} xLabel={xLabel} tooltip={tip} />
      </div>

      <ActivityHeatmap rows={rows()} now={now()} metric={metric()} format={(s) => formatMetric(metric())(metricValue(s, metric()))} tooltip={(s) => <CountsTip s={s} />} />

      <div class="card table-card">
        <table class="table dense">
          <thead>
            <tr>
              <th>Model</th><For each={NUMERIC_COLUMNS}>{(c) => <th class="num">{c}</th>}</For><th>Share</th>
            </tr>
          </thead>
          <tbody>
            <For each={models()} fallback={<tr><td colSpan={MODEL_COLUMN_COUNT} class="muted">No requests in this range.</td></tr>}>
              {(m) => {
                const share = () => (metricValue(total(), metric()) > 0 ? metricValue(m.summary, metric()) / metricValue(total(), metric()) : 0);
                return (
                  <tr>
                    <td class="fill" title={m.model}><div class="cell-name"><ProviderGlyph provider={m.provider} size={14} /><span class="tabular">{m.model || '—'}</span></div></td>
                    <td class="tabular num">{m.summary.requests.toLocaleString()}</td>
                    <TokenCell v={m.summary.inputTokens} />
                    <TokenCell v={m.summary.outputTokens} />
                    <TokenCell v={m.summary.cachedTokens} />
                    <TokenCell v={m.summary.cacheWriteTokens} provider={m.provider} />
                    <td class="tabular num">{hitRate(m.summary)}</td>
                    <td class="tabular num">{m.summary.unpricedRequests === m.summary.requests ? '—' : usd(m.summary.costUsd)}</td>
                    <td style={{ width: '12%' }}><div class="share-bar" title={pct(share() * 100, 1)}><span style={{ width: `${share() * 100}%` }} /></div></td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>

      <p class="muted chart-note">
        API cost uses list prices checked {PRICES_CHECKED}, with cache writes at the 5-minute rate: what the same tokens would cost
        on the pay-as-you-go API, not what a subscription charges.
        <Show when={unpriced().length}> No price for {unpriced().join(', ')}; those requests are left out.</Show>
      </p>
    </>
  );
}
