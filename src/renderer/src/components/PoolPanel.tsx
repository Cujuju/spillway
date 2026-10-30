import { createMemo, For, Show } from 'solid-js';
import { providerLabel } from '@shared/trayValues';
import { persistedSignal } from '../lib/persisted';
import { providerVar } from '../lib/providers';
import { now, settings, updateSettings } from '../store';
import { chartFrom, chartTo, type PoolModel } from './poolModel';
import { QuotaChart } from './QuotaChart';
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
  title: string;
}

/**
 * Remaining/drain chart and forecast, a line per pool. Cards pick pools; cards or picker pick the window.
 * The chart takes the panel's spare height; the wheel zooms its time span.
 */
export function PoolPanel(props: {
  models: PoolModel[];
  /** Providers in view, legend order; those without the charted window show disabled. */
  providers: string[];
  windows: ChartWindow[];
  line: string | null;
  onLine: (id: string) => void;
}) {
  const [tab, setTab] = persistedSignal('dashboard.poolTab', 'remaining', POOL_TABS);
  const shown = createMemo(() => props.models.filter((m) => m.summary()));
  const single = () => shown().length === 1;
  const drainMax = (peak: number) => Math.max(MIN_DRAIN_AXIS, Math.ceil(peak * DRAIN_HEADROOM));
  const series = (kind: 'remaining' | 'drain') =>
    shown().map((m) => ({
      id: m.provider(),
      label: providerLabel(m.provider()),
      color: providerVar(m.provider()),
      past: kind === 'remaining' ? m.past() : m.drain(),
      future: kind === 'remaining' ? m.projection()?.points : undefined,
    }));
  const color = () => (single() ? providerVar(shown()[0]!.provider()) : undefined);
  const charts = (id: string) => shown().some((m) => m.provider() === id);
  const windowLabel = () => props.windows.find((w) => w.value === props.line)?.label ?? 'this';

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
            <Show when={props.windows.length}>
              <Seg label="Chart window" value={props.line ?? ''} options={props.windows} onChange={props.onLine} />
            </Show>
            <select class="select" value={hours()} onChange={(e) => void updateSettings((d) => { d.dashboard.forecastHours = Number(e.currentTarget.value); })}>
              <For each={FORECAST_HOUR_CHOICES}>{(n) => <option value={n}>Next {lengthText(n)}</option>}</For>
            </select>
          </div>
        </div>
        <Show
          when={tab() === 'remaining'}
          fallback={
            <QuotaChart series={series('drain')} from={chartFrom()} to={now()} now={now()} yMax={drainMax} yLabel={(v) => `${v.toFixed(1)}%/h`} ariaLabel="Drain rate chart" />
          }
        >
          <QuotaChart series={series('remaining')} from={chartFrom()} to={chartTo()} now={now()} yMax={() => POOL_FULL} yLabel={(v) => `${Math.round(v)}%`} ariaLabel="Remaining quota chart" />
        </Show>
      </Show>
    </section>
  );
}
