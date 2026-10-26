import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { heatGrid, hourLabel, metricValue, type HeatMode, type Metric, type Summary } from '../lib/activityStats';
import type { ActivityBucket } from '@shared/types';
import { Seg } from './ui';

/** Shades above empty; matches `.heat-cell.l1`–`.l4` in activity.css. */
const LEVELS = 4;
/** Hour labels every 6 hours, like the 0h / 6h / 12h / 18h axis it mirrors. */
const HOUR_LABEL_STEP = 6;
/** Empty plus each shade, for the legend. */
const SHADES = Array.from({ length: LEVELS + 1 }, (_, l) => l);
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** "America/Los_Angeles" → "Los Angeles". */
const zoneLabel = zone.split('/').pop()!.replace(/_/g, ' ');

/** Shade step for a value: 0 is empty; the rest split the range up to the busiest cell. */
export function heatLevel(value: number, max: number): number {
  return value <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((value / max) * LEVELS));
}

export function ActivityHeatmap(props: {
  rows: ActivityBucket[];
  now: number;
  metric: Metric;
  format: (s: Summary) => string;
  tooltip: (s: Summary) => JSX.Element;
}) {
  const [mode, setMode] = createSignal<HeatMode>('week');
  const [tip, setTip] = createSignal<{ x: number; y: number; title: string; s: Summary } | null>(null);
  const grid = createMemo(() => heatGrid(props.rows, mode(), props.now));
  const max = createMemo(() => Math.max(0, ...grid().flatMap((r) => r.cells.map((c) => metricValue(c, props.metric)))));
  let host!: HTMLDivElement;

  const show = (e: Event, day: string, h: number, s: Summary) => {
    const cell = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const box = host.getBoundingClientRect();
    setTip({ x: cell.left - box.left + cell.width / 2, y: cell.bottom - box.top, title: `${day} ${hourLabel(h)}`, s });
  };

  return (
    <div class="card heat-card" ref={host}>
      <div class="chart-head heat-head">
        <div class="section-label">By hour</div>
        <span class="chart-head-note" title={zone}>{zoneLabel} time</span>
        <Seg value={mode()} options={[{ value: 'week', label: 'Last 7 days' }, { value: 'rhythm', label: 'Rhythm', title: 'Each weekday and hour, summed over the last 30 days' }] as const} onChange={setMode} />
      </div>
      <div class="heat" role="grid" aria-label="Activity by day and hour" onPointerLeave={() => setTip(null)}>
        <div />
        <For each={HOURS}>{(h) => <div class="heat-hour">{h % HOUR_LABEL_STEP === 0 ? hourLabel(h) : ''}</div>}</For>
        <For each={grid()}>
          {(row) => (
            <>
              <div class="heat-day">{row.label}</div>
              <For each={row.cells}>
                {(s, h) => (
                  <div
                    class={`heat-cell l${heatLevel(metricValue(s, props.metric), max())}`}
                    role="gridcell"
                    tabindex="0"
                    aria-label={`${row.label} ${hourLabel(h())}: ${props.format(s)}`}
                    onPointerEnter={(e) => show(e, row.label, h(), s)}
                    onFocus={(e) => show(e, row.label, h(), s)}
                    onBlur={() => setTip(null)}
                  />
                )}
              </For>
            </>
          )}
        </For>
      </div>
      <div class="heat-legend">
        less <For each={SHADES}>{(l) => <span class={`heat-cell l${l}`} />}</For> more
      </div>
      <Show when={tip()}>
        {(t) => (
          <div class="chart-tip" style={{ left: `${t().x}px`, top: `${t().y + 6}px`, transform: 'translateX(-50%)' }}>
            <div class="tip-title">{t().title}</div>
            {props.tooltip(t().s)}
          </div>
        )}
      </Show>
    </div>
  );
}
