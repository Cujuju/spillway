import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { inScope, type ActivityScope } from '@shared/activityScope';
import {
  axisLabel, bucketStarts, bucketTitle, bucketUnit, daysToFetch, dayText, isCustomRange, rangeSpan, RANGES, UNIT_NOTE, type CustomRange, type Range,
} from '../lib/activityRange';
import { byAccount, byClient, byModel, series, summarize } from '../lib/activityStats';
import { compactNumber, usd } from '../lib/format';
import { persistedSignal } from '../lib/persisted';
import { activityBuckets, holdActivityDays, now } from '../store';
import { ActivityBoard, AddChartSelect, type PendingChart } from './ActivityBoard';
import { costText, countRows, hitRate, savings } from './activityFormat';
import type { ActivityData } from './activityPanels';
import { Seg } from './ui';

/** Date the price table in src/shared/modelPrices.ts was checked. */
const PRICES_CHECKED = 'Oct 26, 2026';
const RANGE_LABELS: Record<Range, string> = { '24h': '24h', '7d': '7d', '30d': '30d', '90d': '90d', '1y': '1y', all: 'All', custom: 'Custom' };
const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: RANGE_LABELS[value] }));
/** Default custom span: the last 30 days. */
const DEFAULT_CUSTOM_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Toolbar width that fits the full range switch and the Add menu; with dates showing, room for those too. */
const FULL_TOOLBAR_PX = 560;
const FULL_TOOLBAR_CUSTOM_PX = 860;

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
  const [range, setRange] = persistedSignal<Range>('activity.range', '7d', RANGES);
  const [custom, setCustom] = persistedSignal<CustomRange>('activity.customRange',
    { from: dayText(Date.now() - (DEFAULT_CUSTOM_DAYS - 1) * DAY_MS), to: dayText(Date.now()) }, isCustomRange);
  const [placing, setPlacing] = createSignal<PendingChart | null>(null);
  const [toolbarWidth, setToolbarWidth] = createSignal(0);
  const compact = () => toolbarWidth() < (range() === 'custom' ? FULL_TOOLBAR_CUSTOM_PX : FULL_TOOLBAR_PX);

  const earliest = createMemo(() => activityBuckets().reduce<number | null>((min, r) => (min === null || r.start < min ? r.start : min), null));
  const span = createMemo(() => rangeSpan(range(), now(), custom(), earliest()));
  createEffect(() => holdActivityDays(daysToFetch(range(), span(), now())));
  const unit = createMemo(() => bucketUnit(span()));
  const starts = createMemo(() => bucketStarts(span(), unit()));
  const rows = createMemo(() => activityBuckets().filter((r) => inScope(props.scope, r)));
  const scoped = createMemo(() => rows().filter((r) => r.start >= span().from && r.start <= span().to));
  const total = createMemo(() => summarize(scoped()));
  const points = createMemo(() => series(scoped(), starts(), now()));
  const models = createMemo(() => byModel(scoped()));
  const accountRows = createMemo(() => byAccount(scoped()));
  const clientRows = createMemo(() => byClient(scoped()));
  const unpriced = createMemo(() => models().filter((m) => m.summary.unpricedRequests > 0).map((m) => m.model));
  const measureToolbar = (el: HTMLElement) => {
    const observer = new ResizeObserver(([entry]) =>
      setToolbarWidth(entry!.contentRect.width));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };
  const data: ActivityData = {
    points,
    rows,
    span,
    now,
    models,
    accounts: accountRows,
    clients: clientRows,
    account: (authIndex) => props.account(authIndex),
    total,
    bucketNote: () => UNIT_NOTE[unit()],
    xLabel: (t) => axisLabel(t, unit()),
    tip: (i) => ({ title: bucketTitle(points()[i]!.start, points()[i]!.end, unit()), rows: countRows(points()[i]!.summary) }),
  };

  return (
    <>
      <div class="toolbar" ref={measureToolbar}>
        <Seg label="Time frame" compact={compact()} value={range()} options={RANGE_OPTIONS} onChange={setRange} />
        <Show when={range() === 'custom'}>
          <input type="date" class="input" aria-label="From" value={custom().from} max={custom().to}
            onChange={(e) => e.currentTarget.value && setCustom({ ...custom(), from: e.currentTarget.value })} />
          <span class="muted">to</span>
          <input type="date" class="input" aria-label="To" value={custom().to} min={custom().from} max={dayText(now())}
            onChange={(e) => e.currentTarget.value && setCustom({ ...custom(), to: e.currentTarget.value })} />
        </Show>
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
