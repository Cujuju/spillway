import { createEffect, createMemo, Show, type JSX } from 'solid-js';
import { inScope, type ActivityScope } from '@shared/activityScope';
import {
  axisLabel, bucketStarts, bucketTitle, bucketUnit, daysToFetch, rangeSpan, UNIT_NOTE, type CustomRange, type Range,
} from '../lib/activityRange';
import { byAccount, byClient, byModel, series, summarize } from '../lib/activityStats';
import { compactNumber, usd } from '../lib/format';
import { activityBuckets, holdActivityDays, now } from '../store';
import { ActivityBoard, type PendingChart } from './ActivityBoard';
import { ActivityInfo } from './ActivityInfo';
import { ActivityEfforts } from './ActivityEfforts';
import { costText, countRows, hitRate, savings } from './activityFormat';
import type { ActivityData } from './activityPanels';

function Stat(props: { label: string; value: string; sub: string; title?: string; info?: JSX.Element }) {
  return (
    <div class="stat-cell" title={props.title}>
      <div class="stat-label">{props.label}<Show when={props.info}> {props.info}</Show></div>
      <div class="stat-value">{props.value}</div>
      <div class="stat-sub truncate">{props.sub}</div>
    </div>
  );
}

/** Totals for `scope` over the page's time frame on top; the charts below are tiles the user arranges. `placing` comes from the page's Add chart menu. */
export function ActivityOverview(props: {
  scope: ActivityScope; account: (authIndex: string | null) => string;
  range: Range; custom: CustomRange; placing: PendingChart | null; onPlacingEnd: () => void;
}) {
  const range = () => props.range;
  const custom = () => props.custom;

  const earliest = createMemo(() => activityBuckets().reduce<number | null>((min, r) => (min === null || r.start < min ? r.start : min), null));
  const span = createMemo(() => rangeSpan(range(), now(), custom(), earliest()));
  createEffect(() => holdActivityDays(daysToFetch(range(), span(), now())));
  const unit = createMemo(() => bucketUnit(span()));
  const starts = createMemo(() => bucketStarts(span(), unit()));
  const rows = createMemo(() => activityBuckets().filter((r) => inScope(props.scope, r)));
  const scoped = createMemo(() => rows().filter((r) => r.start >= span().from && r.start <= span().to));
  const total = createMemo(() => summarize(scoped()));
  const points = createMemo(() => series(scoped(), starts(), span().to));
  const models = createMemo(() => byModel(scoped()));
  const accountRows = createMemo(() => byAccount(scoped()));
  const clientRows = createMemo(() => byClient(scoped()));
  const unpriced = createMemo(() => models().filter((m) => m.summary.unpricedRequests > 0).map((m) => m.model));
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
      <div class="card stat-strip">
        <Stat label="API cost" value={costText(total())} sub="at list prices" info={<ActivityInfo unpriced={unpriced()} />} />
        <Stat label="Tokens" value={compactNumber(total().totalTokens)} sub={`${compactNumber(total().outputTokens)} output`} />
        <Stat label="Requests" value={total().requests.toLocaleString()} sub={`${total().failed.toLocaleString()} failed`} />
        <Stat label="Cache hit" value={hitRate(total())} sub={`${compactNumber(total().cachedTokens)} from cache`} title="Prompt tokens served from the prompt cache" />
        <Stat label="Cache savings" value={usd(savings(total()))} sub="vs. no caching" title="List-price cost with every prompt token uncached, minus the estimate" />
      </div>

      <ActivityBoard data={data} placing={props.placing} onPlacingEnd={props.onPlacingEnd} />
      <ActivityEfforts rows={scoped()} />
    </>
  );
}
