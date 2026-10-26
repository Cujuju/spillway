import { createMemo, createSignal, For, Show } from 'solid-js';
import type { Credential } from '@shared/types';
import { depletionAt, poolSummary, poolWindowKey, project } from '../lib/forecast';
import { poolShares } from '../lib/poolCapacity';
import { drainRatePerHour, drainSeries, pastSeries } from '../lib/poolHistory';
import { dayTime } from '../lib/format';
import { providerVar } from '../lib/providers';
import { history, now, settings, updateSettings } from '../store';
import { QuotaChart } from './QuotaChart';
import { Seg } from './ui';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FORECAST_DAY_CHOICES = [1, 3, 7, 14] as const;
/** Headroom above the busiest drain sample so the line never touches the top edge. */
const DRAIN_HEADROOM = 1.2;
/** Smallest drain-rate axis, %/hour, so a quiet day still reads as a flat line. */
const MIN_DRAIN_AXIS = 5;
/** Pool figures are percent of the whole pool. */
const POOL_FULL = 100;

/** Pool figures, remaining/drain chart and forecast for one provider (Theo's summary block). */
export function PoolPanel(props: { provider: string; credentials: Credential[]; strategy: string }) {
  const [chosenKey, setChosenKey] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<'remaining' | 'drain'>('remaining');

  const windowOptions = createMemo(() => {
    const seen = new Map<string, { label: string; durationMs: number | null }>();
    for (const c of props.credentials) for (const w of c.windows) if (!seen.has(w.key)) seen.set(w.key, w);
    return [...seen]
      .sort(([, a], [, b]) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity))
      .map(([value, w]) => ({ value, label: w.label }));
  });
  const key = () => {
    const k = chosenKey();
    return k && windowOptions().some((o) => o.value === k) ? k : poolWindowKey(props.credentials);
  };
  const days = () => settings().dashboard.forecastDays;
  const from = () => now() - settings().dashboard.drainLookbackHours * HOUR_MS;
  const to = () => now() + days() * DAY_MS;

  // Accounts weighted by plan size, so a Pro and a Max account add up by what they hold.
  const shares = createMemo(() => (key() ? poolShares(history(), props.credentials, key()!) : new Map()));
  const plans = () => [...new Set(props.credentials.filter((c) => !c.disabled).map((c) => c.plan?.label ?? 'Plan unknown'))].join(' + ');
  const summary = createMemo(() => (key() ? poolSummary(props.credentials, key()!, shares()) : null));
  const rate = createMemo(() => (key() ? drainRatePerHour(history(), shares(), key()!, now(), settings().dashboard.drainLookbackHours) : null));
  const past = createMemo(() => {
    const k = key();
    const s = summary();
    if (!k || !s) return [];
    return [...pastSeries(history(), props.credentials, k, from(), shares()), { t: now(), remaining: s.remaining }];
  });
  const projection = createMemo(() => (key() ? project(props.credentials, key()!, rate() ?? 0, now(), days(), props.strategy, shares()) : null));
  const drain = createMemo(() => (key() ? drainSeries(history(), shares(), key()!, from()) : []));
  const drainMax = () => Math.max(MIN_DRAIN_AXIS, Math.ceil(Math.max(0, ...drain().map((p) => p.remaining)) * DRAIN_HEADROOM));
  const emptyAt = () => (rate() ? depletionAt(projection()?.points ?? []) : null);

  return (
    <section class="summary" style={{ '--pool-color': providerVar(props.provider) }}>
      <Show when={windowOptions().length > 1}>
        <div style={{ 'margin-bottom': '12px' }}>
          <Seg value={key() ?? ''} options={windowOptions()} onChange={setChosenKey} />
        </div>
      </Show>
      <Show when={summary()} fallback={<div class="muted">No limit data for these accounts yet.</div>}>
        {(s) => (
          <>
            <div class="summary-figures">
              <span class="summary-big">{Math.round(s().remaining)}%</span>
              <span class="summary-of" title="Accounts count by plan size">of pool remaining · {plans()}</span>
              <span class="summary-rate">
                {rate() === null ? 'Collecting history for drain rate…' : `~${rate()!.toFixed(1)}%/hour`}
              </span>
            </div>
            <div class="summary-tabs">
              <button classList={{ active: tab() === 'remaining' }} onClick={() => setTab('remaining')}>Remaining quota</button>
              <button classList={{ active: tab() === 'drain' }} onClick={() => setTab('drain')}>Drain rate</button>
              <span class="spacer" />
              <div class="legend" style={{ 'padding-bottom': '8px' }}>
                <span><span class="dot" />Past</span>
                <Show when={tab() === 'remaining'}>
                  <span><span class="dash">- - -</span>Projected</span>
                </Show>
                <select class="select" value={days()} onChange={(e) => void updateSettings((d) => { d.dashboard.forecastDays = Number(e.currentTarget.value); })}>
                  <For each={FORECAST_DAY_CHOICES}>{(n) => <option value={n}>Next {n} {n === 1 ? 'day' : 'days'}</option>}</For>
                </select>
              </div>
            </div>
            <Show
              when={tab() === 'remaining'}
              fallback={
                <QuotaChart past={drain()} from={from()} to={now()} now={now()} yMax={drainMax()} yLabel={(v) => `${v.toFixed(1)}%/h`} color={providerVar(props.provider)} />
              }
            >
              <QuotaChart
                past={past()}
                future={projection()?.points}
                from={from()}
                to={to()}
                now={now()}
                yMax={POOL_FULL}
                yLabel={(v) => `${Math.round(v)}%`}
                color={providerVar(props.provider)}
              />
            </Show>
            <div class="chart-foot">
              <span>
                {projection()?.nextReset
                  ? `Next reset +${Math.round(projection()!.nextReset!.restores)}% of pool · ${dayTime(projection()!.nextReset!.at)}`
                  : 'No reset in range'}
              </span>
              <span>
                {rate() === null ? '' : emptyAt() ? `Pool runs dry ~${dayTime(emptyAt()!)}` : `Lasts the next ${days()} ${days() === 1 ? 'day' : 'days'} at this pace`}
              </span>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
