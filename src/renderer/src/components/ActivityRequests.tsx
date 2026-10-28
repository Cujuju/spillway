import { ChevronDown, ChevronRight } from 'lucide-solid';
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { localDay } from '@shared/activityCounts';
import { tokenCost } from '@shared/modelPrices';
import { maskEmails } from '@shared/privacy';
import type { ActivityDaySummary, ActivityEvent, StoredActivityEvent } from '@shared/types';
import { dayLabel, usd } from '../lib/format';
import { persistedSignal } from '../lib/persisted';
import { now, settings } from '../store';
import { costText } from './activityFormat';
import { TokenCell } from './TokenCell';
import { ProviderGlyph, Seg } from './ui';

const MS_PER_SECOND = 1000;
/** Below this, show milliseconds; above, seconds with one decimal. */
const SHOW_SECONDS_FROM_MS = 1000;
const COLUMN_COUNT = 10;
const CHEVRON_PX = 13;
const FILTERS = [{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }] as const;

/** One day's rows loaded so far. */
interface Section {
  rows: StoredActivityEvent[];
  more: boolean;
  loaded: boolean;
  loading: boolean;
}
const NEW_SECTION: Section = { rows: [], more: false, loaded: false, loading: false };

const isOpenMap = (v: unknown): v is Record<string, boolean> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean');

const duration = (ms: number | null) => (ms === null ? '—' : ms < SHOW_SECONDS_FROM_MS ? `${ms} ms` : `${(ms / MS_PER_SECOND).toFixed(1)} s`);
const requestCost = (e: ActivityEvent) => {
  const cost = tokenCost(e.provider, e.model, e);
  return cost ? usd(cost.usd) : '—';
};
const withRequest = (s: ActivityDaySummary, e: StoredActivityEvent): ActivityDaySummary => {
  const cost = tokenCost(e.provider, e.model, e);
  return {
    ...s, requests: s.requests + 1, failed: s.failed + (e.failed ? 1 : 0), newestId: e.id,
    costUsd: s.costUsd + (cost?.usd ?? 0), unpricedRequests: s.unpricedRequests + (cost ? 0 : 1),
  };
};

function RequestRow(props: { e: StoredActivityEvent; account: (authIndex: string | null) => string }) {
  const errorText = () => {
    const text = props.e.error ?? '';
    return settings().dashboard.showEmails ? text : maskEmails(text);
  };
  return (
    <>
      <tr classList={{ 'has-error': !!errorText() }}>
        <td class="tabular">{new Date(props.e.at).toLocaleTimeString()}</td>
        <td class="fill" title={`${props.account(props.e.authIndex)} · ${props.e.model || 'no model'}`}>
          <div class="cell-name">
            <ProviderGlyph provider={props.e.provider} size="sm" />
            <span>{props.account(props.e.authIndex)} <span class="muted">· {props.e.model || '—'}</span></span>
          </div>
        </td>
        <td>
          <Show when={props.e.failed} fallback={<span class="badge green">OK</span>}>
            <span class="badge red">{props.e.statusCode ?? 'Failed'}</span>
          </Show>
        </td>
        <TokenCell v={props.e.inputTokens} />
        <TokenCell v={props.e.outputTokens} />
        <TokenCell v={props.e.cachedTokens} />
        <TokenCell v={props.e.cacheWriteTokens} provider={props.e.provider} />
        <td class="tabular num">{requestCost(props.e)}</td>
        <td class="tabular num">{duration(props.e.ttftMs)}</td>
        <td class="tabular num">{duration(props.e.latencyMs)}</td>
      </tr>
      {/* The error gets its own line so it never widens the columns. */}
      <Show when={errorText()}>
        <tr class="error-row">
          <td colSpan={COLUMN_COUNT}><div class="truncate" title={errorText()}>{errorText()}</div></td>
        </tr>
      </Show>
    </>
  );
}

/** Stored requests, one collapsible section per day, newest first; open days load more as they scroll. */
export function ActivityRequests(props: { account: (authIndex: string | null) => string }) {
  const [filter, setFilter] = persistedSignal('activity.filter', 'all', FILTERS.map((f) => f.value));
  /** Days the user opened or closed; the rest follow the default, where only today is open. */
  const [toggled, setToggled] = persistedSignal<Record<string, boolean>>('activity.openDays', {}, isOpenMap);
  const [summaries, setSummaries] = createSignal<ActivityDaySummary[]>([]);
  const [sections, setSections] = createSignal<Record<string, Section>>({});
  /** Bumped when the filter changes, so pages loaded under the old one are dropped. */
  let generation = 0;
  /** Live requests that arrive while summaries load; applied after, when newer than the load counted. */
  let liveDuringLoad: StoredActivityEvent[] | null = [];

  const today = () => localDay(now());
  const yesterday = () => {
    const d = new Date(now());
    return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime());
  };
  const dayName = (day: string) => (day === today() ? 'Today' : day === yesterday() ? 'Yesterday' : dayLabel(day));
  const isOpen = (day: string) => toggled()[day] ?? day === today();
  const toggle = (day: string) => setToggled((t) => ({ ...t, [day]: !isOpen(day) }));
  const section = (day: string) => sections()[day] ?? NEW_SECTION;
  const setSection = (day: string, next: (s: Section) => Section) => setSections((all) => ({ ...all, [day]: next(all[day] ?? NEW_SECTION) }));

  const summaryByDay = createMemo(() => new Map(summaries().map((s) => [s.day, s])));
  // Day strings keep each section's rows mounted while its summary updates.
  const shownDays = createMemo(() => summaries().filter((s) => filter() !== 'failed' || s.failed > 0).map((s) => s.day));
  const stored = createMemo(() => summaries().reduce((t, s) => ({ requests: t.requests + s.requests, failed: t.failed + s.failed }), { requests: 0, failed: 0 }));

  const loadPage = (day: string) => {
    const s = section(day);
    if (s.loading || (s.loaded && !s.more)) return;
    const gen = generation;
    setSection(day, (cur) => ({ ...cur, loading: true }));
    void window.api
      .activityPage({ day, failedOnly: filter() === 'failed', before: s.rows.at(-1)?.id ?? null })
      .then((page) => {
        if (gen !== generation) return;
        // Live requests that arrived during the load may be in the page too.
        setSection(day, (cur) => {
          const shown = new Set(cur.rows.map((e) => e.id));
          return { rows: [...cur.rows, ...page.events.filter((e) => !shown.has(e.id))], more: page.more, loaded: true, loading: false };
        });
      })
      .catch((err: unknown) => {
        console.error('[activity] page failed:', err);
        if (gen === generation) setSection(day, (cur) => ({ ...cur, loading: false }));
      });
  };
  /** Loads a day's next page when the end of its rows scrolls into view. */
  const watchEnd = (el: HTMLElement, day: string) => {
    const observer = new IntersectionObserver((entries) => entries.some((en) => en.isIntersecting) && loadPage(day));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };
  const pickFilter = (f: (typeof FILTERS)[number]['value']) => {
    setFilter(f);
    generation += 1;
    setSections({});
  };

  const countLive = (e: StoredActivityEvent) => {
    const day = localDay(Date.parse(e.at));
    const current = summaryByDay().get(day);
    if (current && e.id <= current.newestId) return;
    const next = withRequest(current ?? { day, requests: 0, failed: 0, costUsd: 0, unpricedRequests: 0, newestId: 0 }, e);
    setSummaries((list) => (current ? list.map((s) => (s.day === day ? next : s)) : [next, ...list].sort((a, b) => b.day.localeCompare(a.day))));
  };
  const showLive = (e: StoredActivityEvent) => {
    const day = localDay(Date.parse(e.at));
    // A day that hasn't started loading picks the request up with its first page.
    if (!sections()[day] || (filter() === 'failed' && !e.failed)) return;
    setSection(day, (s) => (s.rows.some((r) => r.id === e.id) ? s : { ...s, rows: [e, ...s.rows] }));
  };

  onMount(() => {
    // An IPC event handler: it reads current state on each event, untracked by design.
    // oxlint-disable-next-line solid/reactivity
    onCleanup(window.api.onActivity((e) => {
      if (liveDuringLoad) liveDuringLoad.push(e);
      else countLive(e);
      showLive(e);
    }));
    void window.api
      .activityDaySummaries()
      .then((list) => {
        setSummaries(list);
        // Forget open/closed choices for days no longer stored.
        const days = new Set(list.map((s) => s.day));
        setToggled((t) => Object.fromEntries(Object.entries(t).filter(([d]) => days.has(d))));
      })
      .catch((err: unknown) => console.error('[activity] day summaries failed:', err))
      .finally(() => {
        for (const e of liveDuringLoad ?? []) countLive(e);
        liveDuringLoad = null;
      });
  });

  return (
    <>
      <div class="toolbar">
        <Seg value={filter()} options={FILTERS} onChange={pickFilter} />
        <span class="spacer" />
        <span class="toolbar-note">{stored().requests.toLocaleString()} stored · {stored().failed.toLocaleString()} failed · newest first</span>
      </div>
      <div class="card table-card requests-card">
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
          <For each={shownDays()} fallback={<tbody><tr><td colSpan={COLUMN_COUNT} class="muted">No requests.</td></tr></tbody>}>
            {(day) => {
              const summary = () => summaryByDay().get(day);
              return (
                <tbody>
                  <tr class="group-row day-row">
                    <td colSpan={COLUMN_COUNT}>
                      <button class="day-toggle" aria-expanded={isOpen(day)} onClick={() => toggle(day)}>
                        <Show when={isOpen(day)} fallback={<ChevronRight size={CHEVRON_PX} />}>
                          <ChevronDown size={CHEVRON_PX} />
                        </Show>
                        <span>{dayName(day)}</span>
                        <span class="muted">
                          {(summary()?.requests ?? 0).toLocaleString()} requests · {(summary()?.failed ?? 0).toLocaleString()} failed · {summary() ? costText(summary()!) : '—'}
                        </span>
                      </button>
                    </td>
                  </tr>
                  <Show when={isOpen(day)}>
                    <For each={section(day).rows}>{(e) => <RequestRow e={e} account={props.account} />}</For>
                    <Show when={!section(day).loaded || section(day).more}>
                      <tr>
                        <td class="more-cell" colSpan={COLUMN_COUNT} ref={(el) => watchEnd(el, day)}>
                          <button class="btn ghost" disabled={section(day).loading} onClick={() => loadPage(day)}>
                            {section(day).loading ? 'Loading…' : 'Show older'}
                          </button>
                        </td>
                      </tr>
                    </Show>
                    <Show when={section(day).loaded && section(day).rows.length === 0}>
                      <tr><td colSpan={COLUMN_COUNT} class="muted">No requests.</td></tr>
                    </Show>
                  </Show>
                </tbody>
              );
            }}
          </For>
        </table>
      </div>
    </>
  );
}
