import { createMemo, createSignal, For, Show } from 'solid-js';
import {
  bucketStarts, byModel, inRange, metricValue, RANGES, series, summarize, type Metric, type Range, type Summary,
} from '../lib/activityStats';
import { compactNumber, pct, usd } from '../lib/format';
import { activityBuckets, now } from '../store';
import { ActivityHeatmap } from './ActivityHeatmap';
import { TrendChart } from './TrendChart';
import { ProviderGlyph, Seg } from './ui';

const USAGE_CHART_PX = 220;
const CACHE_CHART_PX = 160;
/** Date the price table in src/shared/modelPrices.ts was checked. */
const PRICES_CHECKED = 'Oct 26, 2026';

const NUMERIC_COLUMNS = ['Requests', 'Input', 'Output', 'Cache read', 'Cache write', 'Cache hit', 'API cost'];
const RANGE_OPTIONS = [{ value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }] as const;
const METRIC_OPTIONS = [{ value: 'cost', label: 'API cost' }, { value: 'tokens', label: 'Tokens' }, { value: 'requests', label: 'Requests' }] as const;

const formatMetric = (m: Metric) => (v: number) => (m === 'cost' ? usd(v) : compactNumber(v));
const hitRate = (s: Summary) => (s.cacheHitRate === null ? '—' : pct(s.cacheHitRate * 100, 1));

/** Hover readout for one bucket or cell: label left, value right. */
function CountsTip(props: { s: Summary }) {
  const rows = () => [
    [usd(props.s.costUsd), 'API cost'],
    [`${props.s.requests.toLocaleString()}${props.s.failed ? ` (${props.s.failed} failed)` : ''}`, 'Requests'],
    [compactNumber(props.s.inputTokens), 'Input'],
    [compactNumber(props.s.outputTokens), 'Output'],
    [compactNumber(props.s.cachedTokens), 'Cache read'],
    [compactNumber(props.s.cacheWriteTokens), 'Cache write'],
    [hitRate(props.s), 'Cache hit rate'],
  ];
  return <For each={rows()}>{([v, l]) => <div class="tip-row"><span>{l}</span><strong>{v}</strong></div>}</For>;
}

function Tile(props: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div class="card stat-tile" title={props.title}>
      <div class="section-label">{props.label}</div>
      <div class="stat-value tabular">{props.value}</div>
      <Show when={props.sub}><div class="muted">{props.sub}</div></Show>
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
  const bucketLabel = (start: number) => new Date(start).toLocaleString(undefined, daily() ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short', hour: 'numeric' });
  const xLabel = (t: number) => new Date(t).toLocaleString(undefined, daily() || range() === '7d' ? { month: 'numeric', day: 'numeric' } : { hour: 'numeric' });
  const tip = (i: number) => (
    <>
      <div class="tip-title">{bucketLabel(points()[i]!.start)}</div>
      <CountsTip s={points()[i]!.summary} />
    </>
  );

  return (
    <>
      <div class="toolbar">
        <Seg value={range()} options={RANGE_OPTIONS} onChange={setRange} />
        <Seg value={metric()} options={METRIC_OPTIONS} onChange={setMetric} />
      </div>

      <div class="stat-grid">
        <Tile label="API cost" value={usd(total().costUsd)} sub="at list prices" title="What these requests would cost on the pay-as-you-go API" />
        <Tile label="Tokens" value={compactNumber(total().totalTokens)} sub={`${compactNumber(total().outputTokens)} output`} />
        <Tile label="Requests" value={total().requests.toLocaleString()} sub={`${total().failed.toLocaleString()} failed`} />
        <Tile label="Cache hit rate" value={hitRate(total())} sub={`${compactNumber(total().cachedTokens)} read from cache`} title="Prompt tokens served from the prompt cache" />
        <Tile label="Cache savings" value={usd(Math.max(0, total().uncachedCostUsd - total().costUsd))} sub="vs. no caching" title="List-price cost with every prompt token uncached, minus the estimate" />
      </div>

      <div class="card">
        <div class="section-label">{METRIC_OPTIONS.find((o) => o.value === metric())!.label} over time</div>
        <TrendChart kind="bar" height={USAGE_CHART_PX} ariaLabel="Usage over time" points={points().map((p) => ({ start: p.start, value: metricValue(p.summary, metric()) }))}
          yLabel={formatMetric(metric())} xLabel={xLabel} tooltip={tip} />
      </div>
      <div class="card">
        <div class="section-label">Cache hit rate</div>
        <TrendChart kind="line" height={CACHE_CHART_PX} ariaLabel="Cache hit rate over time" yMax={1} points={points().map((p) => ({ start: p.start, value: p.summary.cacheHitRate }))}
          yLabel={(v) => pct(v * 100)} xLabel={xLabel} tooltip={tip} />
      </div>

      <ActivityHeatmap rows={rows()} now={now()} metric={metric()} format={(s) => formatMetric(metric())(metricValue(s, metric()))} tooltip={(s) => <CountsTip s={s} />} />

      <div class="card table-card">
        <table class="table nowrap">
          <thead>
            <tr>
              <th>Model</th><For each={NUMERIC_COLUMNS}>{(c) => <th class="num">{c}</th>}</For><th>Share</th>
            </tr>
          </thead>
          <tbody>
            <For each={models()} fallback={<tr><td colSpan={9} class="muted">No requests in this range.</td></tr>}>
              {(m) => {
                const share = () => (metricValue(total(), metric()) > 0 ? metricValue(m.summary, metric()) / metricValue(total(), metric()) : 0);
                return (
                  <tr>
                    <td><div class="row" style={{ gap: '8px' }}><ProviderGlyph provider={m.provider} size={14} /><span class="tabular">{m.model || '—'}</span></div></td>
                    <td class="tabular num">{m.summary.requests.toLocaleString()}</td>
                    <td class="tabular num">{compactNumber(m.summary.inputTokens)}</td>
                    <td class="tabular num">{compactNumber(m.summary.outputTokens)}</td>
                    <td class="tabular num">{compactNumber(m.summary.cachedTokens)}</td>
                    <td class="tabular num">{compactNumber(m.summary.cacheWriteTokens)}</td>
                    <td class="tabular num">{hitRate(m.summary)}</td>
                    <td class="tabular num">{m.summary.unpricedRequests === m.summary.requests ? '—' : usd(m.summary.costUsd)}</td>
                    <td><div class="share-bar" title={pct(share() * 100, 1)}><span style={{ width: `${share() * 100}%` }} /></div></td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>

      <p class="muted chart-note">
        API cost uses list prices checked {PRICES_CHECKED}, with cache writes at the 5-minute rate; it is what the same tokens would cost
        on the pay-as-you-go API, not what a subscription charges.
        <Show when={unpriced().length}> No price for {unpriced().join(', ')}; those requests are left out of the cost.</Show>
      </p>
    </>
  );
}
