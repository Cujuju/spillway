import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { providerLabel } from '@shared/trayValues';
import { persistedSignal } from '../lib/persisted';
import { providerVar } from '../lib/providers';
import { now, settings, updateSettings } from '../store';
import { chartFrom, chartTo, type PoolModel } from './poolModel';
import { QuotaChart } from './QuotaChart';
import type { TipRow } from './ChartTip';
import { Seg } from './ui';

const HOURS_PER_DAY = 24;
/** Forecast lengths in hours: short ones for 5-hour windows, then days for weekly ones. */
const FORECAST_HOUR_CHOICES = [4, 8, HOURS_PER_DAY, 3 * HOURS_PER_DAY, 7 * HOURS_PER_DAY, 14 * HOURS_PER_DAY];
/** Headroom above the busiest drain sample so the line never touches the top edge. */
const DRAIN_HEADROOM = 1.2;
/** Smallest drain-rate axis, %/hour, so a quiet day still reads as a flat line. */
const MIN_DRAIN_AXIS = 5;
/** Pool figures are percent of the whole pool. */
const POOL_FULL = 100;

const POOL_TABS = ['remaining', 'drain'] as const;
const hours = () => settings().dashboard.forecastHours;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
const lengthText = (h: number) => (h % HOURS_PER_DAY ? plural(h, 'hour') : plural(h / HOURS_PER_DAY, 'day'));

export interface ChartWindow {
  /** Card line id (`lengthLineId` or `scopedLineId`). */
  value: string;
  label: string;
  tipRows: TipRow[];
}

/** Pixel value of a CSS length property (custom or resolved). */
const px = (style: CSSStyleDeclaration, prop: string) => parseFloat(style.getPropertyValue(prop)) || 0;

/**
 * Remaining/drain charts, a line per pool. If every window's chart fits the spare height they stack
 * and the window picker hides; else one chart shows the picked window.
 */
export function PoolPanel(props: {
  /** Pool models charted for a window (card line id). */
  modelsOf: (line: string) => PoolModel[];
  /** Providers in view, legend order; those without the charted window show disabled. */
  providers: string[];
  windows: ChartWindow[];
  line: string | null;
  onLine: (id: string) => void;
}) {
  const [tab, setTab] = persistedSignal('dashboard.poolTab', 'remaining', POOL_TABS);
  /** How many labelled charts fit the chart area's height. */
  const [room, setRoom] = createSignal(1);
  const measure = (el: HTMLDivElement) => {
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const style = getComputedStyle(el);
      const item = px(style, '--chart-min-height') + px(style, '--pool-label-height');
      const gap = px(style, 'row-gap');
      setRoom(Math.floor((e.contentRect.height + gap) / (item + gap)));
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  const stacked = () => props.windows.length > 1 && room() >= props.windows.length;
  const lines = () => (stacked() ? props.windows.map((w) => w.value) : props.line ? [props.line] : []);
  const shownOf = (line: string) => props.modelsOf(line).filter((m) => m.summary());
  const shown = createMemo(() => lines().flatMap(shownOf));
  const charts = (id: string) => shown().some((m) => m.provider() === id);
  const single = () => new Set(shown().map((m) => m.provider())).size === 1;
  const drainMax = (peak: number) => Math.max(MIN_DRAIN_AXIS, Math.ceil(peak * DRAIN_HEADROOM));
  const series = (line: string, kind: 'remaining' | 'drain') =>
    shownOf(line).map((m) => ({
      id: m.provider(),
      label: providerLabel(m.provider()),
      color: providerVar(m.provider()),
      past: kind === 'remaining' ? m.past() : m.drain(),
      future: kind === 'remaining' ? m.projection()?.points : undefined,
    }));
  const color = () => (single() ? providerVar(shown()[0]!.provider()) : undefined);
  const labelOf = (line: string) => props.windows.find((w) => w.value === line)?.label ?? 'this';
  const windowLabel = () => lines().map(labelOf).join(' or ') || 'this';
  const chart = (line: string) => (
    <Show
      when={tab() === 'remaining'}
      fallback={
        <QuotaChart series={series(line, 'drain')} from={chartFrom()} to={now()} now={now()} yMax={drainMax} yLabel={(v) => `${v.toFixed(1)}%/h`} ariaLabel={`${labelOf(line)} drain rate chart`} />
      }
    >
      <QuotaChart series={series(line, 'remaining')} from={chartFrom()} to={chartTo()} now={now()} yMax={() => POOL_FULL} yLabel={(v) => `${Math.round(v)}%`} ariaLabel={`${labelOf(line)} remaining quota chart`} />
    </Show>
  );

  return (
    <section class="summary" style={{ '--pool-color': color() }}>
      <Show when={shown().length} fallback={<div class="muted">No limit data for these accounts yet.</div>}>
        <div class="summary-tabs">
          <button classList={{ active: tab() === 'remaining' }} onClick={() => setTab('remaining')}>Remaining quota</button>
          <button classList={{ active: tab() === 'drain' }} onClick={() => setTab('drain')}>Drain rate</button>
          <span class="spacer" />
          <div class="legend">
            <For each={props.providers}>
              {(id) => (
                <span
                  classList={{ absent: !charts(id) }}
                  style={{ '--pool-color': providerVar(id) }}
                  title={charts(id) ? undefined : `${providerLabel(id)} reports no ${windowLabel()} window`}
                >
                  <span class="dot" />
                  {providerLabel(id)}
                </span>
              )}
            </For>
            <Show when={tab() === 'remaining'}>
              <span><span class="dash">- - -</span>Projected</span>
            </Show>
            <Show when={props.windows.length && !stacked()}>
              <Seg label="Chart window" value={props.line ?? ''} options={props.windows} onChange={props.onLine} />
            </Show>
            <select class="select" value={hours()} onChange={(e) => void updateSettings((d) => { d.dashboard.forecastHours = Number(e.currentTarget.value); })}>
              <For each={FORECAST_HOUR_CHOICES}>{(n) => <option value={n}>Next {lengthText(n)}</option>}</For>
            </select>
          </div>
        </div>
        <div class="pool-charts">
          <div class="pool-stack" ref={measure}>
            <Show when={stacked()} fallback={<For each={lines()}>{(line) => chart(line)}</For>}>
              <For each={lines()}>
                {(line) => (
                  <div class="pool-stack-item">
                    <div class="pool-chart-label">{labelOf(line)}</div>
                    {chart(line)}
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  );
}
