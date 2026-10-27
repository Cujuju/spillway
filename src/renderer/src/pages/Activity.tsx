import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { reportsCacheWrites, tokenCost } from '@shared/modelPrices';
import { maskEmails } from '@shared/privacy';
import { MAX_ACTIVITY_EVENTS, type ActivityEvent } from '@shared/types';
import { ActivityOverview } from '../components/ActivityOverview';
import { ActivityTotals } from '../components/ActivityTotals';
import { TokenCell } from '../components/TokenCell';
import { Notice, ProviderGlyph, Seg } from '../components/ui';
import { dayLabel, usd } from '../lib/format';
import { activity, proxyStatus, settings, snapshot } from '../store';

const MS_PER_SECOND = 1000;
/** Below this, show milliseconds; above, seconds with one decimal. */
const SHOW_SECONDS_FROM_MS = 1000;
/** Rows added per "Show older" on a stored day; matches the recent list's length. */
const PAGE_SIZE = MAX_ACTIVITY_EVENTS;
/** Day picker value for the live recent list. */
const RECENT = '';
const REQUEST_COLUMN_COUNT = 10;

const duration = (ms: number | null) => (ms === null ? '—' : ms < SHOW_SECONDS_FROM_MS ? `${ms} ms` : `${(ms / MS_PER_SECOND).toFixed(1)} s`);
const requestCost = (e: ActivityEvent) => {
  const cost = tokenCost(e.provider, e.model, e);
  return cost ? usd(cost.usd) : '—';
};

export function Activity() {
  const [view, setView] = createSignal<'overview' | 'requests' | 'totals'>('overview');
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
      <header class="dash-header title-row">
        <h1 class="dash-title">Activity</h1>
        <Seg value={view()} options={[{ value: 'overview', label: 'Overview' }, { value: 'requests', label: 'Requests' }, { value: 'totals', label: 'Daily totals' }] as const} onChange={setView} />
      </header>

      <Show when={proxyStatus()?.state !== 'running'}>
        <Notice>New activity appears while the proxy is running.</Notice>
      </Show>

      <Show when={view() === 'overview'}>
        <ActivityOverview />
      </Show>
      <Show when={view() === 'totals'}>
        <ActivityTotals account={accountName} />
      </Show>
      <Show when={view() === 'requests'}>
        <div class="toolbar">
          <select class="select" value={day()} onChange={(e) => pickDay(e.currentTarget.value)}>
            <option value={RECENT}>Recent</option>
            <For each={days()}>{(d) => <option value={d}>{dayLabel(d)}</option>}</For>
          </select>
          <Seg value={filter()} options={[{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }] as const} onChange={setFilter} />
          <span class="spacer" />
          <span class="toolbar-note">{source().length.toLocaleString()} {scope()} · {failedCount()} failed · newest first</span>
        </div>
        <div class="card table-card">
          <table class="table dense">
            <thead>
              <tr>
                <th>Time</th>
                <th>Account · model</th>
                <th>Result</th>
                <th class="num">Input</th>
                <th class="num">Output</th>
                <th class="num">Cache read</th>
                <th class="num">Cache write</th>
                <th class="num" title="At API list prices">API cost</th>
                <th class="num" title="Time to first token">First token</th>
                <th class="num">Total time</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows().slice(0, limit())} fallback={<tr><td colSpan={REQUEST_COLUMN_COUNT} class="muted">No requests.</td></tr>}>
                {(e) => (
                  <>
                    <tr classList={{ 'has-error': !!errorText(e) }}>
                      <td class="tabular">{new Date(e.at).toLocaleTimeString()}</td>
                      <td class="fill" title={`${accountName(e.authIndex)} · ${e.model || 'no model'}`}>
                        <div class="cell-name">
                          <ProviderGlyph provider={e.provider} size="sm" />
                          <span>{accountName(e.authIndex)} <span class="muted">· {e.model || '—'}</span></span>
                        </div>
                      </td>
                      <td>
                        <Show when={e.failed} fallback={<span class="badge green">OK</span>}>
                          <span class="badge red">{e.statusCode ?? 'Failed'}</span>
                        </Show>
                      </td>
                      <TokenCell v={e.inputTokens} />
                      <TokenCell v={e.outputTokens} />
                      <TokenCell v={e.cachedTokens} />
                      <TokenCell v={e.cacheWriteTokens} provider={e.provider} />
                      <td class="tabular num">{requestCost(e)}</td>
                      <td class="tabular num">{duration(e.ttftMs)}</td>
                      <td class="tabular num">{duration(e.latencyMs)}</td>
                    </tr>
                    {/* The error gets its own line so it never widens the columns. */}
                    <Show when={errorText(e)}>
                      <tr class="error-row">
                        <td colSpan={REQUEST_COLUMN_COUNT}><div class="truncate" title={errorText(e)}>{errorText(e)}</div></td>
                      </tr>
                    </Show>
                  </>
                )}
              </For>
            </tbody>
          </table>
          <Show when={rows().length > limit()}>
            <div class="more-row">
              <button class="btn ghost" onClick={() => setLimit((l) => l + PAGE_SIZE)}>Show older</button>
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}
