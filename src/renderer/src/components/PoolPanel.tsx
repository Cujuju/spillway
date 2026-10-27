import { createMemo, createSignal, For, mapArray, Show } from 'solid-js';
import { providerLabel } from '@shared/trayValues';
import { poolWindowKey } from '../lib/forecast';
import { dayTime } from '../lib/format';
import { durationChoices, keyChoices, keyForDuration } from '../lib/poolWindows';
import { providerVar } from '../lib/providers';
import { now, settings, updateSettings } from '../store';
import { chartFrom, chartTo, createPoolModel, type PoolInput, type PoolModel } from './poolModel';
import { QuotaChart } from './QuotaChart';
import { ProviderGlyph, ResetTime, Seg } from './ui';

const FORECAST_DAY_CHOICES = [1, 3, 7, 14] as const;
/** Headroom above the busiest drain sample so the line never touches the top edge. */
const DRAIN_HEADROOM = 1.2;
/** Smallest drain-rate axis, %/hour, so a quiet day still reads as a flat line. */
const MIN_DRAIN_AXIS = 5;
/** Pool figures are percent of the whole pool. */
const POOL_FULL = 100;

const days = () => settings().dashboard.forecastDays;
const daysText = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
const rateText = (m: PoolModel) => (m.rate() === null ? 'Collecting history for drain rate…' : `~${m.rate()!.toFixed(1)}%/hour`);
const paceText = (m: PoolModel) =>
  m.rate() === null ? '' : m.emptyAt() ? `Pool runs dry ~${dayTime(m.emptyAt()!)}` : `Lasts the next ${daysText(days())} at this pace`;

/**
 * Pool figures, remaining/drain chart and forecast. One provider shows its own windows; several
 * share one chart, a line each, matched by window length (each provider's 5-hour, or weekly).
 */
export function PoolPanel(props: { pools: PoolInput[]; strategy: string }) {
  const [chosen, setChosen] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<'remaining' | 'drain'>('remaining');
  const single = () => props.pools.length === 1;

  const options = createMemo(() => (single() ? keyChoices(props.pools[0]!.credentials) : durationChoices(props.pools.map((p) => p.credentials))));
  // Default: one provider's widest window; for several, the longest length they share.
  const choice = () => {
    const c = chosen();
    if (c && options().some((o) => o.value === c)) return c;
    return single() ? poolWindowKey(props.pools[0]!.credentials) : (options().at(-1)?.value ?? null);
  };
  const keyFor = (pool: PoolInput) => {
    const c = choice();
    if (!c) return null;
    return single() ? c : keyForDuration(pool.credentials, Number(c));
  };

  const models = mapArray(
    () => props.pools,
    (pool) => createPoolModel(() => pool, () => keyFor(pool), () => props.strategy),
  );
  const shown = createMemo(() => models().filter((m) => m.summary()));
  const drainMax = () => Math.max(MIN_DRAIN_AXIS, Math.ceil(Math.max(0, ...shown().flatMap((m) => m.drain().map((p) => p.remaining))) * DRAIN_HEADROOM));
  const series = (kind: 'remaining' | 'drain') =>
    shown().map((m) => ({
      id: m.provider(),
      label: providerLabel(m.provider()),
      color: providerVar(m.provider()),
      past: kind === 'remaining' ? m.past() : m.drain(),
      future: kind === 'remaining' ? m.projection()?.points : undefined,
    }));
  const color = () => (single() ? providerVar(props.pools[0]!.provider) : undefined);

  return (
    <section class="summary" style={{ '--pool-color': color() }}>
      <Show when={options().length > 1}>
        <div style={{ 'margin-bottom': '12px' }}>
          <Seg value={choice() ?? ''} options={options()} onChange={setChosen} />
        </div>
      </Show>
      <Show when={shown().length} fallback={<div class="muted">No limit data for these accounts yet.</div>}>
        <Show
          when={single()}
          fallback={
            <div class="summary-multi">
              <For each={shown()}>
                {(m) => (
                  <div class="summary-pool" style={{ '--pool-color': providerVar(m.provider()) }}>
                    <ProviderGlyph provider={m.provider()} />
                    <span class="summary-mid">{Math.round(m.summary()!.remaining)}%</span>
                    <span class="summary-of" title="Accounts count by plan size">{providerLabel(m.provider())} · {m.plans()}</span>
                    <span class="summary-rate">{rateText(m)}</span>
                  </div>
                )}
              </For>
            </div>
          }
        >
          <div class="summary-figures">
            <span class="summary-big">{Math.round(shown()[0]!.summary()!.remaining)}%</span>
            <span class="summary-of" title="Accounts count by plan size">of pool remaining · {shown()[0]!.plans()}</span>
            <span class="summary-rate">{rateText(shown()[0]!)}</span>
          </div>
        </Show>
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
        <div class="chart-foot" classList={{ stacked: !single() }}>
          <For each={shown()}>
            {(m) => (
              <div class="chart-foot-row">
                <Show when={!single()}><ProviderGlyph provider={m.provider()} size={12} /></Show>
                <Show when={m.projection()?.nextReset} fallback={<span>No reset in range</span>}>
                  {(r) => <span>Next reset <ResetTime at={r().at} now={now()} /> · +{Math.round(r().restores)}% of pool</span>}
                </Show>
                <span class="spacer" />
                <span>{paceText(m)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
