import { createMemo, createSignal, Show } from 'solid-js';
import { inScope, type ActivityScope } from '@shared/activityScope';
import { bucketStarts, byAccount, byClient, byModel, inRange, RANGES, series, summarize, type Range, type SeriesPoint } from '../lib/activityStats';
import { compactNumber, usd } from '../lib/format';
import { persistedSignal } from '../lib/persisted';
import { activityBuckets, now } from '../store';
import { ActivityBoard, AddChartSelect, type PendingChart } from './ActivityBoard';
import { costText, countRows, hitRate, savings } from './activityFormat';
import type { ActivityData } from './activityPanels';
import { Seg } from './ui';

/** Date the price table in src/shared/modelPrices.ts was checked. */
const PRICES_CHECKED = 'Oct 26, 2026';
const RANGE_OPTIONS = [{ value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }] as const;
const BUCKET_NOTE: Record<Range, string> = { '24h': 'Hourly', '7d': 'Every 3 hours', '30d': 'Daily' };

function Stat(props: { label: string; value: string; sub: string; title?: string }) {
  return (
    <div class="stat-cell" title={props.title}>
      <div class="stat-label">{props.label}</div>
      <div class="stat-value">{props.value}</div>
      <div class="stat-sub truncate">{props.sub}</div>
    </div>
  );
}

/** Range and totals for `scope` stay on top; the charts below are tiles the user arranges. */
export function ActivityOverview(props: { scope: ActivityScope; account: (authIndex: string | null) => string }) {
  const [range, setRange] = persistedSignal<Range>('activity.range', '7d', RANGE_OPTIONS.map((o) => o.value));
  const [placing, setPlacing] = createSignal<PendingChart | null>(null);

  const starts = createMemo(() => bucketStarts(range(), now()));
  const rows = createMemo(() => activityBuckets().filter((r) => inScope(props.scope, r)));
  const scoped = createMemo(() => inRange(rows(), starts()));
  const total = createMemo(() => summarize(scoped()));
  const points = createMemo(() => series(scoped(), starts(), now()));
  const models = createMemo(() => byModel(scoped()));
  const accountRows = createMemo(() => byAccount(scoped()));
  const clientRows = createMemo(() => byClient(scoped()));
  const unpriced = createMemo(() => models().filter((m) => m.summary.unpricedRequests > 0).map((m) => m.model));
  const daily = () => RANGES[range()].hoursPerBucket >= 24;
  /** "Mon, Oct 26" for a day; "Mon 3 AM" for an hour; "Mon 3 AM – 6 AM" for a multi-hour bar. */
  const bucketLabel = (p: SeriesPoint) => {
    if (daily()) return new Date(p.start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const start = new Date(p.start).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
    return RANGES[range()].hoursPerBucket > 1 ? `${start} – ${new Date(p.end).toLocaleTimeString(undefined, { hour: 'numeric' })}` : start;
  };
  const data: ActivityData = {
    points,
    rows,
    now,
    models,
    accounts: accountRows,
    clients: clientRows,
    account: (authIndex) => props.account(authIndex),
    total,
    bucketNote: () => BUCKET_NOTE[range()],
    xLabel: (t) => new Date(t).toLocaleString(undefined, daily() || range() === '7d' ? { month: 'numeric', day: 'numeric' } : { hour: 'numeric' }),
    tip: (i) => ({ title: bucketLabel(points()[i]!), rows: countRows(points()[i]!.summary) }),
  };

  return (
    <>
      <div class="toolbar">
        <Seg value={range()} options={RANGE_OPTIONS} onChange={setRange} />
        <span class="spacer" />
        <AddChartSelect onPick={setPlacing} />
      </div>

      <div class="card stat-strip">
        <Stat label="API cost" value={costText(total())} sub="at list prices" title="What these requests would cost on the pay-as-you-go API" />
        <Stat label="Tokens" value={compactNumber(total().totalTokens)} sub={`${compactNumber(total().outputTokens)} output`} />
        <Stat label="Requests" value={total().requests.toLocaleString()} sub={`${total().failed.toLocaleString()} failed`} />
        <Stat label="Cache hit" value={hitRate(total())} sub={`${compactNumber(total().cachedTokens)} from cache`} title="Prompt tokens served from the prompt cache" />
        <Stat label="Cache savings" value={usd(savings(total()))} sub="vs. no caching" title="List-price cost with every prompt token uncached, minus the estimate" />
      </div>

      <ActivityBoard data={data} placing={placing()} onPlacingEnd={() => setPlacing(null)} />

      <p class="muted chart-note">
        API cost uses list prices checked {PRICES_CHECKED}, with cache writes at the 5-minute rate: what the same tokens would cost
        on the pay-as-you-go API, not what a subscription charges.
        <Show when={unpriced().length}> No price for {unpriced().join(', ')}; those requests are left out.</Show>
      </p>
    </>
  );
}
