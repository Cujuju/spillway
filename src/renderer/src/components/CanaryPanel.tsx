import { createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Check, Minus, Play, Settings2, TriangleAlert, X } from 'lucide-solid';
import { CANARY_PROBES, type CanaryStatus } from '@shared/canary';
import { compactNumber, dateTime, dayLabel, msDuration, pct } from '../lib/format';
import { canaryDaily, canaryTargets, latestBatch, rangeDays, targetLabel } from '../lib/canaryView';
import { proxyStatus, settings } from '../store';
import { CanarySetup } from './CanarySetup';
import { DriftChart } from './DriftChart';
import { InfoTip, type TipRow } from './ChartTip';
import { Notice } from './ui';

const ICON_PX = 14;
const CHART_HEIGHT_PX = 150;
const OUTCOME_ICON = { pass: Check, fail: X, error: TriangleAlert } as const;

function Legend(props: { items: { label: string; color: string }[] }) {
  return <div class="canary-legend"><For each={props.items}>{(i) => <span><i style={{ background: i.color }} />{i.label}</span>}</For></div>;
}

/** Scheduled probes with known answers: the one check here that holds the input fixed. */
export function CanaryPanel(props: { from: string; to: string; models: string[] }) {
  const [status, setStatus] = createSignal<CanaryStatus | null>(null);
  void window.api.canaryStatus().then(setStatus).catch(() => undefined);
  onCleanup(window.api.onCanaryChange(setStatus));
  const [editing, setEditing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Refetch when a run starts or finishes; lastRunAt alone is set at the start.
  const [results] = createResource(() => ({ from: props.from, to: props.to, ran: status()?.lastRunAt ?? null, running: status()?.running ?? false }), (q) => window.api.canaryResults({ from: q.from, to: q.to }));
  const days = createMemo(() => rangeDays(props.from, props.to));
  const targets = createMemo(() => canaryTargets(settings().canary.targets, results.latest ?? []));
  const daily = createMemo(() => canaryDaily(results.latest ?? [], days(), targets()));
  const batch = createMemo(() => latestBatch(results.latest ?? []));
  const hasResults = () => (results.latest?.length ?? 0) > 0;
  const proxyDown = () => proxyStatus()?.state !== 'running';
  const runNow = async () => {
    setError(null);
    try { setStatus(await window.api.canaryRunNow()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const statusText = () => {
    const s = status();
    if (s?.running) return 'Running probes…';
    if (!settings().canary.enabled) return 'Off';
    const parts = [`Every ${settings().canary.intervalHours} h`, `${s?.callsPerRun ?? 0} calls per run`];
    if (s?.nextRunAt) parts.push(`next ${dateTime(s.nextRunAt)}`);
    return parts.join(' · ');
  };
  const tip = (metric: 'passRate' | 'thinking') => (i: number): { title: string; rows: TipRow[] } => ({
    title: dayLabel(days()[i]!),
    rows: daily().map((t) => { const v = t[metric][i]; return { label: t.label, value: v === null || v === undefined ? '—' : metric === 'passRate' ? pct(v * 100) : compactNumber(v), color: t.color }; }),
  });

  return (
    <section class="card canary">
      <header class="drift-section-head">
        <h3 class="section-label">Canary probes</h3>
        <InfoTip title="Canary probes" note={`${CANARY_PROBES.length} fixed reasoning problems with one right answer, sent at a fixed model and effort. Usage can't tell a weaker model from easier work; a fixed prompt can. A falling pass rate or thinking count at the same effort is the clearest sign of a change upstream.`} />
        <span class="canary-status" classList={{ on: settings().canary.enabled, running: status()?.running }}>{statusText()}</span>
        <div class="canary-actions">
          <button class="btn ghost" type="button" disabled={status()?.running || !settings().canary.targets.length || proxyDown()} title={proxyDown() ? 'Start the proxy to run probes' : undefined} onClick={() => void runNow()}><Play size={ICON_PX} />Run now</button>
          <button class="btn ghost" type="button" aria-expanded={editing()} classList={{ active: editing() }} onClick={() => setEditing((v) => !v)}><Settings2 size={ICON_PX} />{settings().canary.targets.length ? 'Set up' : 'Set up probes'}</button>
        </div>
      </header>
      <Show when={error() ?? status()?.lastError}>{(e) => <Notice tone="error">{e()}</Notice>}</Show>
      <Show when={editing() || (!hasResults() && !settings().canary.targets.length)}><CanarySetup models={props.models} /></Show>
      <Show when={hasResults()} fallback={
        <Show when={settings().canary.targets.length}><p class="muted canary-empty">No probe results in this range yet. {settings().canary.enabled ? 'The first run starts soon.' : 'Turn probes on or press Run now.'}</p></Show>
      }>
        <div class="canary-charts">
          <div class="canary-chart">
            <div class="canary-chart-head"><span>Pass rate</span><Legend items={daily()} /></div>
            <DriftChart days={days()} height={CHART_HEIGHT_PX} yMax={1} yLabel={(v) => pct(v * 100)} ariaLabel="Canary pass rate per day" tooltip={tip('passRate')}
              lines={daily().map((t) => ({ label: t.label, color: t.color, values: t.passRate }))} />
          </div>
          <div class="canary-chart">
            <div class="canary-chart-head"><span>Thinking per probe</span></div>
            <DriftChart days={days()} height={CHART_HEIGHT_PX} yLabel={compactNumber} ariaLabel="Canary thinking tokens per probe per day" tooltip={tip('thinking')}
              lines={daily().map((t) => ({ label: t.label, color: t.color, values: t.thinking }))} />
          </div>
        </div>
        <Show when={batch()}>
          {(b) => (
            <div class="canary-batch">
              <div class="canary-chart-head">
                <span>Latest run</span>
                <span class="muted">{dateTime(b().at)} · {b().passed}/{b().graded} passed{b().errors ? ` · ${b().errors} errors` : ''}</span>
              </div>
              <table class="table dense canary-grid">
                <thead><tr><th>Probe</th><For each={b().targets}>{(t) => <th class="num">{targetLabel(t)}</th>}</For></tr></thead>
                <tbody>
                  <For each={b().probes}>
                    {(p) => (
                      <tr>
                        <td>{p.title}</td>
                        <For each={p.cells}>
                          {(c) => (
                            <td class="num">
                              <span class={`canary-outcome ${c.outcome ?? 'none'}`} title={c.result?.error ?? (c.result?.answer ? `Answered ${c.result.answer}` : undefined)}>
                                <Show when={c.outcome} fallback={<Minus size={ICON_PX} />}>{(o) => <Dynamic component={OUTCOME_ICON[o()]} size={ICON_PX} />}</Show>
                                <Show when={c.result}>{(r) => <span class="muted">{r().thinkingTokens === null ? '' : `${compactNumber(r().thinkingTokens!)} thinking · `}{msDuration(r().latencyMs)}</span>}</Show>
                              </span>
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          )}
        </Show>
      </Show>
    </section>
  );
}
