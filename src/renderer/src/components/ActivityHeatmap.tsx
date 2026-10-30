import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import type { ActivityBucket } from '@shared/types';
import { calendarWeeks, heatShape, hourRows } from '../lib/activityHeat';
import type { Span } from '../lib/activityRange';
import { hourLabel, metricValue, type Metric, type Summary } from '../lib/activityStats';
import { ChartTip, type TipRow } from './ChartTip';

/** Shades above empty; matches `.heat-cell.l1`–`.l4` in activity.css. */
const LEVELS = 4;
/** Hour labels every 6 hours, like the 0h / 6h / 12h / 18h axis it mirrors. */
const HOUR_LABEL_STEP = 6;
/** Empty plus each shade, for the legend. */
const SHADES = Array.from({ length: LEVELS + 1 }, (_, l) => l);
/** Calendar rows labelled like GitHub's: Mon, Wed, Fri. */
const LABELLED_WEEKDAYS = new Set([0, 2, 4]);
const DAYS_PER_WEEK = 7;
/** Starts from a Monday, so local short names run Monday first. */
const WEEKDAY_NAMES = Array.from({ length: DAYS_PER_WEEK }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));

/** Shade step for a value: 0 is empty; the rest split the range up to the busiest cell. */
export function heatLevel(value: number, max: number): number {
  return value <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((value / max) * LEVELS));
}

export function ActivityHeatmap(props: {
  rows: ActivityBucket[];
  span: Span;
  metric: Metric;
  format: (s: Summary) => string;
  tooltip: (s: Summary) => TipRow[];
}) {
  const [tip, setTip] = createSignal<{ cell: HTMLElement; title: string; s: Summary } | null>(null);
  const shape = createMemo(() => heatShape(props.span));
  const hours = createMemo(() => (shape() === 'calendar' ? [] : hourRows(props.rows, props.span)));
  const weeks = createMemo(() => (shape() === 'calendar' ? calendarWeeks(props.rows, props.span) : []));
  const max = createMemo(() => Math.max(0, ...(shape() === 'calendar'
    ? weeks().flatMap((w) => w.days.flatMap((d) => (d ? [metricValue(d, props.metric)] : [])))
    : hours().flatMap((r) => r.cells.map((c) => metricValue(c, props.metric))))));
  const level = (s: Summary) => heatLevel(metricValue(s, props.metric), max());
  const cellProps = (title: string, s: Summary) => ({
    role: 'cell' as const, tabindex: '0', 'aria-label': `${title}: ${props.format(s)}`,
    onPointerEnter: (e: Event) => setTip({ cell: e.currentTarget as HTMLElement, title, s }),
    onFocus: (e: Event) => setTip({ cell: e.currentTarget as HTMLElement, title, s }),
    onBlur: () => setTip(null),
  });
  const dayTitle = (start: number, i: number) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div class="heat-card" onPointerLeave={() => setTip(null)}>
      <Switch>
        <Match when={shape() !== 'calendar'}>
          <div class="heat" role="table" aria-label="Activity by day and hour (24-hour clock)">
            <div role="row" style={{ display: 'contents' }}>
              <div role="columnheader" />
              <For each={hours()[0]?.hours ?? []}>{(h) => <div role="columnheader" class="heat-hour"><span>{h % HOUR_LABEL_STEP === 0 ? String(h).padStart(2, '0') : ''}</span></div>}</For>
            </div>
            <For each={hours()}>{(row) => (
              <div role="row" style={{ display: 'contents' }}>
                <div class="heat-day" role="rowheader">{row.label}</div>
                <For each={row.cells}>{(s, i) => (
                  <div class={`heat-cell l${level(s)}`} {...cellProps(`${row.label} ${hourLabel(row.hours[i()]!)}`.trim(), s)} />
                )}</For>
              </div>
            )}</For>
          </div>
        </Match>
        <Match when={shape() === 'calendar'}>
          <div class="heat-calendar" role="table" aria-label="Activity by day" style={{ '--heat-weeks': String(weeks().length) }}>
            <For each={WEEKDAY_NAMES}>{(name, d) => (
              <div role="row" style={{ display: 'contents' }}>
                <div class="heat-day" role="rowheader" aria-label={name} style={{ 'grid-row': d() + 1 }}>{LABELLED_WEEKDAYS.has(d()) ? name : ''}</div>
                <For each={weeks()}>{(week, w) => (
                  <Show when={week.days[d()]} fallback={<div role="cell" class="heat-blank" style={{ 'grid-row': d() + 1, 'grid-column': w() + 2 }} />}>
                    {(s) => <div class={`heat-cell l${level(s())}`} style={{ 'grid-row': d() + 1, 'grid-column': w() + 2 }} {...cellProps(dayTitle(week.start, d()), s())} />}
                  </Show>
                )}</For>
              </div>
            )}</For>
          </div>
        </Match>
      </Switch>
      <div class="heat-legend">
        less <For each={SHADES}>{(l) => <span class={`heat-cell l${l}`} />}</For> more
      </div>
      <Show when={tip()}>
        {(t) => <ChartTip title={t().title} rows={props.tooltip(t().s)} anchor={() => (t().cell.isConnected ? t().cell.getBoundingClientRect() : null)} />}
      </Show>
    </div>
  );
}
