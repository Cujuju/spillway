import { createMemo, createSignal, For, Show } from 'solid-js';
import { providerLabel } from '@shared/trayValues';
import { providerVar } from '../lib/providers';
import { now, settings, updateSettings } from '../store';
import { chartFrom, chartTo, type PoolModel } from './poolModel';
import { QuotaChart } from './QuotaChart';

const FORECAST_DAY_CHOICES = [1, 3, 7, 14] as const;
/** Headroom above the busiest drain sample so the line never touches the top edge. */
const DRAIN_HEADROOM = 1.2;
/** Smallest drain-rate axis, %/hour, so a quiet day still reads as a flat line. */
const MIN_DRAIN_AXIS = 5;
/** Pool figures are percent of the whole pool. */
const POOL_FULL = 100;

const days = () => settings().dashboard.forecastDays;
const daysText = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * Remaining/drain chart and forecast, a line per pool (the provider cards pick pools and window).
 * The chart takes the panel's spare height.
 */
export function PoolPanel(props: { models: PoolModel[] }) {
  const [tab, setTab] = createSignal<'remaining' | 'drain'>('remaining');
  const shown = createMemo(() => props.models.filter((m) => m.summary()));
  const single = () => shown().length === 1;
  const drainMax = () => Math.max(MIN_DRAIN_AXIS, Math.ceil(Math.max(0, ...shown().flatMap((m) => m.drain().map((p) => p.remaining))) * DRAIN_HEADROOM));
  const series = (kind: 'remaining' | 'drain') =>
    shown().map((m) => ({
      id: m.provider(),
      label: providerLabel(m.provider()),
      color: providerVar(m.provider()),
      past: kind === 'remaining' ? m.past() : m.drain(),
      future: kind === 'remaining' ? m.projection()?.points : undefined,
    }));
  const color = () => (single() ? providerVar(shown()[0]!.provider()) : undefined);

  return (
    <section class="summary" style={{ '--pool-color': color() }}>
      <Show when={shown().length} fallback={<div class="muted">No limit data for these accounts yet.</div>}>
        <div class="summary-tabs">
          <button classList={{ active: tab() === 'remaining' }} onClick={() => setTab('remaining')}>Remaining quota</button>
          <button classList={{ active: tab() === 'drain' }} onClick={() => setTab('drain')}>Drain rate</button>
          <span class="spacer" />
          <div class="legend" style={{ 'padding-bottom': '8px' }}>
            <Show when={!single()}>
              <For each={shown()}>
                {(m) => <span style={{ '--pool-color': providerVar(m.provider()) }}><span class="dot" />{providerLabel(m.provider())}</span>}
              </For>
            </Show>
            <Show when={single()}><span><span class="dot" />Past</span></Show>
            <Show when={tab() === 'remaining'}>
              <span><span class="dash">- - -</span>Projected</span>
            </Show>
            <select class="select" value={days()} onChange={(e) => void updateSettings((d) => { d.dashboard.forecastDays = Number(e.currentTarget.value); })}>
              <For each={FORECAST_DAY_CHOICES}>{(n) => <option value={n}>Next {daysText(n)}</option>}</For>
            </select>
          </div>
        </div>
        <Show
          when={tab() === 'remaining'}
          fallback={
            <QuotaChart series={series('drain')} from={chartFrom()} to={now()} now={now()} yMax={drainMax()} yLabel={(v) => `${v.toFixed(1)}%/h`} ariaLabel="Drain rate chart" />
          }
        >
          <QuotaChart series={series('remaining')} from={chartFrom()} to={chartTo()} now={now()} yMax={POOL_FULL} yLabel={(v) => `${Math.round(v)}%`} ariaLabel="Remaining quota chart" />
        </Show>
      </Show>
    </section>
  );
}
