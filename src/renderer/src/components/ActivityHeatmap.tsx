import { createMemo, createSignal, For, Show } from 'solid-js';
import type { ActivityBucket } from '@shared/types';
import { weekdayHours } from '../lib/activityHeat';
import type { Span } from '../lib/activityRange';
import { hourLabel, metricValue, type Metric, type Summary } from '../lib/activityStats';
import { ChartTip, HoverTip, type TipRow } from './ChartTip';

/** Shades above empty; matches `.heat-cell.l1`–`.l4` in activity.css. */
const LEVELS = 4;
/** Hour labels every 6 hours, like the 0h / 6h / 12h / 18h axis it mirrors. */
const HOUR_LABEL_STEP = 6;
/** Empty plus each shade, for the legend. */
const SHADES = Array.from({ length: LEVELS + 1 }, (_, l) => l);
const DAYS_PER_WEEK = 7;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Starts from a Monday, so local short names run Monday first. */
const WEEKDAY_NAMES = Array.from({ length: DAYS_PER_WEEK }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }));

/** Shade step for a value: 0 is empty; the rest split the range up to the busiest cell. */
export function heatLevel(value: number, max: number): number {
  return value <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((value / max) * LEVELS));
}

/** Weekday by hour, summed over the page's time frame. The grid never changes shape; cells stretch to fill the tile. */
export function ActivityHeatmap(props: {
  rows: ActivityBucket[];
  span: Span;
  metric: Metric;
  format: (s: Summary) => string;
  tooltip: (s: Summary) => TipRow[];
}) {
  const [tip, setTip] = createSignal<{ cell: HTMLElement; title: string; s: Summary } | null>(null);
  const grid = createMemo(() => weekdayHours(props.rows, props.span));
  const max = createMemo(() => Math.max(0, ...grid().days.flatMap((day) => day.map((c) => metricValue(c, props.metric)))));
  const show = (e: Event, title: string, s: Summary) => setTip({ cell: e.currentTarget as HTMLElement, title, s });

  return (
    <div class="heat-card" onPointerLeave={() => setTip(null)}>
      <div class="heat-body">
        <div class="heat" role="table" aria-label="Activity by weekday and hour (24-hour clock)">
          <div role="row" style={{ display: 'contents' }}>
            <div role="columnheader" class="heat-day" />
            <For each={HOURS}>{(h) => <div role="columnheader" class="heat-hour">{h % HOUR_LABEL_STEP === 0 ? String(h).padStart(2, '0') : ''}</div>}</For>
          </div>
          <For each={grid().days}>{(cells, d) => (
            <div role="row" style={{ display: 'contents' }}>
              <div class="heat-day" role="rowheader">{WEEKDAY_NAMES[d()]}</div>
              <For each={cells}>{(s, h) => {
                const title = () => `${WEEKDAY_NAMES[d()]} ${hourLabel(h())}`;
                return (
                  <div class={`heat-cell l${heatLevel(metricValue(s, props.metric), max())}`} role="cell" tabindex="0"
                    aria-label={`${title()}: ${props.format(s)}`}
                    onPointerEnter={(e) => show(e, title(), s)} onFocus={(e) => show(e, title(), s)} onBlur={() => setTip(null)} />
                );
              }}</For>
            </div>
          )}</For>
        </div>
      </div>
      <div class="heat-legend">
        less <For each={SHADES}>{(l) => <span class={`heat-cell l${l}`} />}</For> more
        <Show when={grid().undetailedDays > 0}>
          <span class="spacer" />
          <HoverTip title="Missing hourly detail" rows={[{ label: 'Days', value: grid().undetailedDays.toLocaleString() }, { label: 'Reason', value: 'Older days keep daily totals only' }]}>
            <span>{grid().undetailedDays}d without hours</span>
          </HoverTip>
        </Show>
      </div>
      <Show when={tip()}>
        {(t) => <ChartTip title={t().title} rows={props.tooltip(t().s)} anchor={() => (t().cell.isConnected ? t().cell.getBoundingClientRect() : null)} />}
      </Show>
    </div>
  );
}
