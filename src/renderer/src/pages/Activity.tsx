import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { maskEmails } from '@shared/privacy';
import { MAX_ACTIVITY_EVENTS, type ActivityEvent } from '@shared/types';
import { ActivityTotals } from '../components/ActivityTotals';
import { Notice, ProviderGlyph, Seg } from '../components/ui';
import { dayLabel } from '../lib/format';
import { activity, proxyStatus, settings, snapshot } from '../store';

const MS_PER_SECOND = 1000;
/** Below this, show milliseconds; above, seconds with one decimal. */
const SHOW_SECONDS_FROM_MS = 1000;
/** Rows added per "Show older" on a stored day; matches the recent list's length. */
const PAGE_SIZE = MAX_ACTIVITY_EVENTS;
/** Day picker value for the live recent list. */
const RECENT = '';

const duration = (ms: number | null) => (ms === null ? '—' : ms < SHOW_SECONDS_FROM_MS ? `${ms} ms` : `${(ms / MS_PER_SECOND).toFixed(1)} s`);
const tokens = (v: number) => v.toLocaleString();

export function Activity() {
  const [view, setView] = createSignal<'requests' | 'totals'>('requests');
  const [filter, setFilter] = createSignal<'all' | 'failed'>('all');
  const [day, setDay] = createSignal(RECENT);
  const [days, setDays] = createSignal<string[]>([]);
  const [stored, setStored] = createSignal<ActivityEvent[]>([]);
  const [limit, setLimit] = createSignal(PAGE_SIZE);
  onMount(() => void window.api.activityDays().then(setDays));

  const pickDay = (d: string) => {
    setDay(d);
    setLimit(PAGE_SIZE);
    setStored([]);
    // A slow load for an earlier pick must not replace the current day.
    if (d) void window.api.activityDay(d).then((events) => day() === d && setStored(events));
  };

  // snapshot() is already masked when "Show emails" is off.
  const accountNames = createMemo(() => new Map((snapshot()?.credentials ?? []).map((c) => [c.authIndex, c.label])));
  const accountName = (authIndex: string | null) => (authIndex ? (accountNames().get(authIndex) ?? authIndex) : '—');
  const errorText = (e: ActivityEvent) => {
    const text = e.error ?? '';
    return settings().dashboard.showEmails ? text : maskEmails(text);
  };
  const source = () => (day() ? stored() : activity());
  const rows = createMemo(() => {
    const all = source();
    const shown = filter() === 'failed' ? all.filter((e) => e.failed) : all;
    return [...shown].reverse();
  });
  const failedCount = () => source().filter((e) => e.failed).length;
  const scope = () => (day() ? dayLabel(day()) : 'recent');

  return (
    <>
      <header class="dash-header">
        <div>
          <h1 class="dash-title">Activity</h1>
          <div class="dash-sub">
            <Show when={view() === 'requests'} fallback="Requests and tokens per day, account and model">
              Each upstream attempt, newest first · {source().length} {scope()}, {failedCount()} failed
            </Show>
          </div>
        </div>
        <div class="dash-actions">
          <Seg value={view()} options={[{ value: 'requests', label: 'Requests' }, { value: 'totals', label: 'Daily totals' }] as const} onChange={setView} />
          <Show when={view() === 'requests'}>
            <select class="select" value={day()} onChange={(e) => pickDay(e.currentTarget.value)}>
              <option value={RECENT}>Recent</option>
              <For each={days()}>{(d) => <option value={d}>{dayLabel(d)}</option>}</For>
            </select>
            <Seg value={filter()} options={[{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }] as const} onChange={setFilter} />
          </Show>
        </div>
      </header>

      <Show when={proxyStatus()?.state !== 'running'}>
        <Notice>New activity appears while the proxy is running.</Notice>
      </Show>

      <div class="card" style={{ padding: 0 }}>
        <Show when={view() === 'requests'} fallback={<ActivityTotals account={accountName} />}>
          <table class="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Account</th>
                <th>Model</th>
                <th>Result</th>
                <th title="Input / output / cached tokens">Tokens</th>
                <th title="Time to first token">First token</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows().slice(0, limit())} fallback={<tr><td colSpan={7} class="muted">No requests.</td></tr>}>
                {(e) => (
                  <tr>
                    <td class="tabular">{new Date(e.at).toLocaleTimeString()}</td>
                    <td>
                      <div class="row" style={{ gap: '8px' }}>
                        <ProviderGlyph provider={e.provider} size={14} />
                        <span>{accountName(e.authIndex)}</span>
                      </div>
                    </td>
                    <td class="tabular">{e.model || '—'}</td>
                    <td>
                      <Show when={e.failed} fallback={<span class="badge green">OK</span>}>
                        <span class="badge red" title={errorText(e)}>{e.statusCode ?? 'Failed'}</span>
                        <span class="muted" style={{ 'margin-left': '6px' }}>{errorText(e)}</span>
                      </Show>
                    </td>
                    <td class="tabular">{tokens(e.inputTokens)} / {tokens(e.outputTokens)} / {tokens(e.cachedTokens)}</td>
                    <td class="tabular">{duration(e.ttftMs)}</td>
                    <td class="tabular">{duration(e.latencyMs)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={rows().length > limit()}>
            <div style={{ padding: '12px', 'text-align': 'center' }}>
              <button class="btn ghost" onClick={() => setLimit((l) => l + PAGE_SIZE)}>Show older</button>
            </div>
          </Show>
        </Show>
      </div>
    </>
  );
}
