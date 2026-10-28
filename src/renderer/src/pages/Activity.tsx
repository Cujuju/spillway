import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { reportsCacheWrites, tokenCost } from '@shared/modelPrices';
import { maskEmails } from '@shared/privacy';
import type { ActivityCount, ActivityEvent, StoredActivityEvent } from '@shared/types';
import { ActivityOverview } from '../components/ActivityOverview';
import { ActivityTotals } from '../components/ActivityTotals';
import { TokenCell } from '../components/TokenCell';
import { Notice, ProviderGlyph, Seg } from '../components/ui';
import { dayLabel, usd } from '../lib/format';
import { isString, persistedSignal } from '../lib/persisted';
import { proxyStatus, settings, snapshot } from '../store';

const MS_PER_SECOND = 1000;
/** Below this, show milliseconds; above, seconds with one decimal. */
const SHOW_SECONDS_FROM_MS = 1000;
/** Day picker value for every stored day, newest first, with live requests on top. */
const RECENT = '';
const EMPTY_COUNT: ActivityCount = { requests: 0, failed: 0, newestId: 0 };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
const DATE_TIME: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...TIME };
const REQUEST_COLUMN_COUNT = 10;
const VIEWS = [{ value: 'overview', label: 'Overview' }, { value: 'requests', label: 'Requests' }, { value: 'totals', label: 'Daily totals' }] as const;
const FILTERS = [{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }] as const;

const duration = (ms: number | null) => (ms === null ? '—' : ms < SHOW_SECONDS_FROM_MS ? `${ms} ms` : `${(ms / MS_PER_SECOND).toFixed(1)} s`);
const requestCost = (e: ActivityEvent) => {
  const cost = tokenCost(e.provider, e.model, e);
  return cost ? usd(cost.usd) : '—';
};
/** The date shows only on rows from before today. */
const requestTime = (e: ActivityEvent) => {
  const at = new Date(e.at);
  return at.toLocaleString(undefined, at.toDateString() === new Date().toDateString() ? TIME : DATE_TIME);
};

export function Activity() {
  const [view, setView] = persistedSignal('activity.view', 'overview', VIEWS.map((v) => v.value));
  const [filter, setFilter] = persistedSignal('activity.filter', 'all', FILTERS.map((f) => f.value));
  const [day, setDay] = persistedSignal('activity.day', RECENT, isString);
  const [days, setDays] = createSignal<string[]>([]);
  const [rows, setRows] = createSignal<StoredActivityEvent[]>([]);
  const [more, setMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [count, setCount] = createSignal(EMPTY_COUNT);
  /** Bumped on each reload, so a slow response for an earlier day or filter is dropped. */
  let generation = 0;

  const loadPage = (before: number | null) => {
    const gen = generation;
    setLoading(true);
    void window.api
      .activityPage({ day: day() || null, failedOnly: filter() === 'failed', before })
      .then((page) => {
        if (gen !== generation) return;
        // Live requests that arrived during the load may be in the page too.
        setRows((prev) => {
          const shown = new Set(prev.map((e) => e.id));
          return [...prev, ...page.events.filter((e) => !shown.has(e.id))];
        });
        setMore(page.more);
      })
      .catch((err: unknown) => console.error('[activity] page failed:', err))
      .finally(() => gen === generation && setLoading(false));
  };
  const reload = () => {
    generation += 1;
    const gen = generation;
    setRows([]);
    setMore(false);
    setCount(EMPTY_COUNT);
    loadPage(null);
    void window.api.activityCount(day() || null).then((c) => gen === generation && setCount(c));
  };
  const loadOlder = () => {
    const oldest = rows().at(-1);
    if (more() && !loading() && oldest) loadPage(oldest.id);
  };
  /** Loads the next page when the end of the list scrolls into view. */
  const watchEnd = (el: HTMLElement) => {
    const observer = new IntersectionObserver((entries) => entries.some((en) => en.isIntersecting) && loadOlder());
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };
  const pickDay = (d: string) => {
    setDay(d);
    reload();
  };
  const pickFilter = (f: (typeof FILTERS)[number]['value']) => {
    setFilter(f);
    reload();
  };

  onMount(() => {
    // An IPC event handler: it reads the current day and filter on each event, untracked by design.
    // oxlint-disable-next-line solid/reactivity
    const off = window.api.onActivity((e) => {
      if (day() !== RECENT || e.id <= count().newestId) return;
      setCount((c) => ({ requests: c.requests + 1, failed: c.failed + (e.failed ? 1 : 0), newestId: e.id }));
      if (filter() !== 'failed' || e.failed) setRows((prev) => (prev.some((p) => p.id === e.id) ? prev : [e, ...prev]));
    });
    onCleanup(off);
    void window.api.activityDays().then((list) => {
      setDays(list);
      // Fall back to Recent when a restored day has no stored requests left.
      if (day() && !list.includes(day())) setDay(RECENT);
      reload();
    });
  });

  // snapshot() is already masked when "Show emails" is off.
  const accountNames = createMemo(() => new Map((snapshot()?.credentials ?? []).map((c) => [c.authIndex, c.label])));
  const accountName = (authIndex: string | null) => (authIndex ? (accountNames().get(authIndex) ?? authIndex) : '—');
  const errorText = (e: ActivityEvent) => {
    const text = e.error ?? '';
    return settings().dashboard.showEmails ? text : maskEmails(text);
  };
  const scope = () => (day() ? dayLabel(day()) : 'stored');

  return (
    <>
      <header class="dash-header title-row">
        <h1 class="dash-title">Activity</h1>
        <Seg value={view()} options={VIEWS} onChange={setView} />
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
          <Seg value={filter()} options={FILTERS} onChange={pickFilter} />
          <span class="spacer" />
          <span class="toolbar-note">{count().requests.toLocaleString()} {scope()} · {count().failed.toLocaleString()} failed · newest first</span>
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
              <For each={rows()} fallback={<tr><td colSpan={REQUEST_COLUMN_COUNT} class="muted">{loading() ? 'Loading…' : 'No requests.'}</td></tr>}>
                {(e) => (
                  <>
                    <tr classList={{ 'has-error': !!errorText(e) }}>
                      <td class="tabular">{requestTime(e)}</td>
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
          <Show when={more()}>
            <div class="more-row" ref={watchEnd}>
              <button class="btn ghost" disabled={loading()} onClick={loadOlder}>{loading() ? 'Loading…' : 'Show older'}</button>
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}
