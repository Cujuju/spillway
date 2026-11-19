import { createEffect, createMemo, Show, type JSX } from 'solid-js';
import { inScope, type ActivityScope } from '@shared/activityScope';
import type { CompareReport } from '@shared/activityCompare';
import {
  axisLabel, bucketStarts, bucketTitle, bucketUnit, daysToFetch, floorTo, UNIT_NOTE, type Range, type Span,
} from '../lib/activityRange';
import { byAccount, byClient, byModel, byModelEffort, series, summarize } from '../lib/activityStats';
import { compactNumber, usd } from '../lib/format';
import { createOlderBuckets } from '../lib/olderActivity';
import { Notice } from './ui';
import { activityBuckets, holdActivityDays, now, settings } from '../store';
import { ActivityBoard, type PendingChart } from './ActivityBoard';
import { ActivityInfo } from './ActivityInfo';
import { costText, countRows, hitRate, savings } from './activityFormat';
import type { ActivityData } from './activityPanels';
import { appLocale } from '@shared/timeFormat';

function Stat(props: { label: string; value: string; sub: string; title?: string; info?: JSX.Element }) {
  return (
    <div class="stat-cell" title={props.title}>
      <div class="stat-label">{props.label}<Show when={props.info}> {props.info}</Show></div>
      <div class="stat-value">{props.value}</div>
      <div class="stat-sub truncate">{props.sub}</div>
    </div>
  );
}

/** Totals for `scope` over the page's time frame (`span`) on top; the charts below are tiles the user arranges. `placing` comes from the page's add menus. */
export function ActivityOverview(props: {
  scope: ActivityScope; account: (authIndex: string | null) => string;
  range: Range; span: Span; compare: CompareReport | null | undefined; placing: PendingChart | null; onPlacingEnd: () => void;
}) {
  const range = () => props.range;
  const span = () => props.span;
  createEffect(() => holdActivityDays(daysToFetch(range(), span(), now())));
  const unit = createMemo(() => bucketUnit(span()));
  const starts = createMemo(() => bucketStarts(span(), unit()));
  const older = createOlderBuckets(span);
  // ClickHouse rows end where local totals begin, so the two never count the same hour.
  const olderRows = createMemo(() => {
    const read = older();
    if (read?.state !== 'ok') return [];
    // A read from before local totals reached further back must not count their days twice.
    const local = activityBuckets();
    if (!local.length) return read.buckets;
    const localFrom = floorTo(local.reduce((min, r) => Math.min(min, r.start), Infinity), 'day');
    return read.buckets.filter((r) => r.start < localFrom);
  });
  const rows = createMemo(() => [...activityBuckets(), ...olderRows()].filter((r) => inScope(props.scope, r)));
  const scoped = createMemo(() => rows().filter((r) => r.start >= span().from && r.start <= span().to));
  const olderNote = createMemo<{ tone: 'warn' | 'info'; text: string } | null>(() => {
    const read = older();
    if (read?.state === 'unavailable') return { tone: 'warn', text: `ClickHouse is unavailable, so activity older than the local data is missing from this range. ${read.error}` };
    if (read?.state !== 'ok' || !olderRows().some((r) => r.start >= span().from && r.start <= span().to)) return null;
    return { tone: 'info', text: `Activity older than the local data comes from ClickHouse.${read.truncated ? ' Its row limit was reached, so some of it is missing.' : ''}` };
  });
  const total = createMemo(() => summarize(scoped()));
  const points = createMemo(() => series(scoped(), starts(), span().to));
  const models = createMemo(() => byModel(scoped()));
  const efforts = createMemo(() => byModelEffort(scoped()));
  const accountRows = createMemo(() => byAccount(scoped()));
  const clientRows = createMemo(() => byClient(scoped()));
  const unpriced = createMemo(() => models().filter((m) => m.summary.unpricedRequests > 0).map((m) => m.model));
  const data: ActivityData = {
    points,
    rows,
    span,
    now,
    models,
    efforts,
    accounts: accountRows,
    clients: clientRows,
    account: (authIndex) => props.account(authIndex),
    total,
    bucketNote: () => UNIT_NOTE[unit()],
    xLabel: (t) => axisLabel(t, unit()),
    tip: (i) => ({ title: bucketTitle(points()[i]!.start, points()[i]!.end, unit()), rows: countRows(points()[i]!.summary) }),
    compare: () => props.compare,
    retentionDays: () => settings().activity.retentionDays,
  };

  return (
    <>
      <Show when={olderNote()}>{(note) => <Notice tone={note().tone}>{note().text}</Notice>}</Show>
      <div class="card stat-strip">
        <Stat label="API cost" value={costText(total())} sub="at list prices" info={<ActivityInfo unpriced={unpriced()} />} />
        <Stat label="Tokens" value={compactNumber(total().totalTokens)} sub={`${compactNumber(total().outputTokens)} output`} />
        <Stat label="Requests" value={total().requests.toLocaleString(appLocale())} sub={`${total().failed.toLocaleString(appLocale())} failed`} />
        <Stat label="Cache hit" value={hitRate(total())} sub={`${compactNumber(total().cachedTokens)} from cache`} title="Prompt tokens served from the prompt cache" />
        <Stat label="Cache savings" value={usd(savings(total()))} sub="vs. no caching" title="List-price cost with every prompt token uncached, minus the estimate" />
      </div>

      <ActivityBoard data={data} placing={props.placing} onPlacingEnd={props.onPlacingEnd} />
    </>
  );
}
