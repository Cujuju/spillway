import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-solid';
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { localDay } from '@shared/activityCounts';
import { inScope, type ActivityScope } from '@shared/activityScope';
import { ACTIVITY_PAGE_SIZE, type StoredActivityEvent } from '@shared/types';
import type { DaySummaries } from '../lib/daySummaries';
import { conversationLabel } from '../lib/conversationNames';
import { dayLabel } from '../lib/format';
import { OLDER_DAYS_WINDOW } from '@shared/activityOlder';
import { createOlderDays, olderPage, OlderReadError } from '../lib/olderActivity';
import { persistedSignal } from '../lib/persisted';
import { createRequestOrder, DEFAULT_SORT, isRecordedOrder, isRequestSort, nextSort, REQUEST_COLUMNS, type RequestSort } from '../lib/requestSort';
import { now } from '../store';
import { costText } from './activityFormat';
import { REQUEST_COLUMN_COUNT, RequestRow } from './RequestRow';
import { appLocale } from '@shared/timeFormat';

export type RequestFilter = 'all' | 'failed';
const CHEVRON_PX = 13;
const SORT_ARROW_PX = 11;

/** One day's rows loaded so far. */
interface Section {
  rows: StoredActivityEvent[];
  more: boolean;
  loaded: boolean;
  loading: boolean;
  /** Rows shown under an order sorted here; revealed a page at a time. */
  shown: number;
  /** Why a ClickHouse day's last read returned nothing. */
  error: string | null;
  /** ClickHouse's row limit cut the day short. */
  truncated: boolean;
}
const NEW_SECTION: Section = { rows: [], more: false, loaded: false, loading: false, shown: 0, error: null, truncated: false };

const isOpenMap = (v: unknown): v is Record<string, boolean> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean');

/** Stored requests, one collapsible section per day, newest day first; open days load more as they scroll. */
export function ActivityRequests(props: { account: (authIndex: string | null) => string; scope: ActivityScope; filter: RequestFilter; days: DaySummaries }) {
  /** Days the user opened or closed; the rest follow the default, where only today is open. */
  const [toggled, setToggled] = persistedSignal<Record<string, boolean>>('activity.openDays', {}, isOpenMap);
  const [sort, setSort] = persistedSignal<RequestSort>('activity.requestSort', DEFAULT_SORT, isRequestSort);
  const [sections, setSections] = createSignal<Record<string, Section>>({});
  /** Bumped when the filters or order change, so loads started under the old ones are dropped. */
  let generation = 0;

  const today = () => localDay(now());
  const yesterday = () => {
    const d = new Date(now());
    return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime());
  };
  const dayName = (day: string) => (day === today() ? 'Today' : day === yesterday() ? 'Yesterday' : dayLabel(day));
  const isOpen = (day: string) => toggled()[day] ?? day === today();
  const toggle = (day: string) => setToggled((t) => ({ ...t, [day]: !isOpen(day) }));
  const failedOnly = () => props.filter === 'failed';
  const section = (day: string) => sections()[day] ?? NEW_SECTION;
  const setSection = (day: string, next: (s: Section) => Section) => setSections((all) => ({ ...all, [day]: next(all[day] ?? NEW_SECTION) }));
  const older = createOlderDays(() => props.scope);
  /** A day read from ClickHouse; a day still stored locally stays local. */
  const isOlder = (day: string) => older.byDay().has(day) && !props.days.byDay().has(day);
  // Day strings keep each section's rows mounted while its summary updates.
  const shownDays = createMemo(() => [...props.days.list(), ...older.list().filter((s) => isOlder(s.day))].filter((s) => !failedOnly() || s.failed > 0).map((s) => s.day));

  /** Times each day changed store; a load started before the latest change is dropped. */
  const storeChanges = new Map<string, number>();
  // A late local request moves a ClickHouse day to the local store; that day's rows start over.
  const olderDays = createMemo(() => new Set(older.list().map((s) => s.day).filter(isOlder)));
  createEffect(on(olderDays, (now, before) => {
    const moved = new Set([...now, ...before ?? now].filter((day) => now.has(day) !== (before ?? now).has(day)));
    if (!moved.size) return;
    for (const day of moved) storeChanges.set(day, (storeChanges.get(day) ?? 0) + 1);
    setSections((all) => Object.fromEntries(Object.entries(all).filter(([day]) => !moved.has(day))));
    // The scroll sentinel of an open day stays in view, so nothing else would ask for its first page.
    for (const day of moved) if (isOpen(day)) loadMore(day);
  }));
  createEffect(on([() => props.filter, () => props.scope, sort], () => {
    generation += 1;
    setSections({});
  }, { defer: true }));
  // Forget open/closed choices for days in neither store. Only the unfiltered list holds every stored day.
  createEffect(on(() => props.days.loaded(), (loaded) => {
    if (!loaded || props.scope.accounts !== null || props.scope.clients !== null || props.scope.efforts != null || props.scope.source === 'proxy') return;
    const days = props.days.byDay(), olderDays = older.byDay();
    setToggled((t) => Object.fromEntries(Object.entries(t).filter(([d]) => days.has(d) || olderDays.has(d))));
  }));

  const fetchInto = (day: string, load: () => Promise<{ events: StoredActivityEvent[]; more: boolean; truncated?: boolean }>) => {
    const gen = generation;
    const change = storeChanges.get(day) ?? 0;
    setSection(day, (cur) => ({ ...cur, loading: true, error: null }));
    void load()
      .then((page) => {
        if (gen !== generation || change !== (storeChanges.get(day) ?? 0)) return;
        // Live requests that arrived during the load may be in it too.
        setSection(day, (cur) => {
          const shown = new Set(cur.rows.map((e) => e.id));
          return { ...cur, rows: [...cur.rows, ...page.events.filter((e) => !shown.has(e.id))], more: page.more, loaded: true, loading: false, shown: ACTIVITY_PAGE_SIZE, truncated: page.truncated === true };
        });
      })
      .catch((err: unknown) => {
        console.error('[activity] requests failed to load:', err);
        if (gen === generation && change === (storeChanges.get(day) ?? 0)) setSection(day, (cur) => ({ ...cur, loading: false, error: err instanceof OlderReadError ? err.message : null }));
      });
  };
  /** Newest first pages from the database; other orders load the whole day once, then reveal it a page at a time. */
  const loadMore = (day: string) => {
    const s = section(day);
    if (s.loading) return;
    // Read now, so the load matches the filters it started under.
    const failed = failedOnly();
    const scope = props.scope;
    if (isOlder(day)) {
      // ClickHouse rows carry no local id, so they page by position.
      const whole = !isRecordedOrder(sort());
      if (!s.loaded || (!whole && s.more)) fetchInto(day, () => olderPage({ day, failedOnly: failed, scope, offset: s.rows.length, whole }));
      else if (whole && s.shown < s.rows.length) setSection(day, (cur) => ({ ...cur, shown: cur.shown + ACTIVITY_PAGE_SIZE }));
    } else if (isRecordedOrder(sort())) {
      const query = { day, failedOnly: failed, scope, before: s.rows.at(-1)?.id ?? null };
      if (!s.loaded || s.more) fetchInto(day, () => window.api.activityPage(query));
    } else if (!s.loaded) {
      fetchInto(day, () => window.api.activityDay(day, failed, scope).then((events) => ({ events, more: false })));
    } else if (s.shown < s.rows.length) {
      setSection(day, (cur) => ({ ...cur, shown: cur.shown + ACTIVITY_PAGE_SIZE }));
    }
  };
  /** Loads more of a day when the end of its rows scrolls into view. */
  const watchEnd = (el: HTMLElement, day: string) => {
    const observer = new IntersectionObserver((entries) => entries.some((en) => en.isIntersecting) && loadMore(day));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };

  onMount(() => {
    // An IPC event handler: it reads current state on each event, untracked by design.
    // oxlint-disable-next-line solid/reactivity
    onCleanup(window.api.onActivity((e) => {
      const day = localDay(Date.parse(e.at));
      // A day that hasn't started loading picks the request up with its first load.
      if (!sections()[day] || (failedOnly() && !e.failed) || !inScope(props.scope, e)) return;
      setSection(day, (s) => (s.rows.some((r) => r.id === e.id) ? s : { ...s, rows: [e, ...s.rows] }));
    }));
  });

  return (
    <div class="card table-card requests-card">
      <div class="requests-scroll">
      <table class="table dense">
        <thead>
          <tr>
            <For each={REQUEST_COLUMNS}>
              {(col) => (
                <th class={col.num ? 'num' : undefined} title={col.title} aria-sort={sort().key === col.key ? (sort().desc ? 'descending' : 'ascending') : undefined}>
                  <button type="button" class="sort-btn" onClick={() => setSort(nextSort(sort(), col.key))}>
                    {col.label}
                    <Show when={sort().key === col.key}>
                      <Show when={sort().desc} fallback={<ArrowUp size={SORT_ARROW_PX} />}>
                        <ArrowDown size={SORT_ARROW_PX} />
                      </Show>
                    </Show>
                  </button>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <For each={shownDays()} fallback={<tbody><tr><td colSpan={REQUEST_COLUMN_COUNT} class="muted">No requests.</td></tr></tbody>}>
          {(day) => {
            const summary = () => props.days.byDay().get(day) ?? older.byDay().get(day);
            // Same object until this day's section changes, so other days' updates don't re-sort it.
            const own = createMemo(() => section(day));
            const ordered = createRequestOrder(() => own().rows, sort, { account: (id) => props.account(id), conversation: conversationLabel });
            const rows = createMemo(() => isRecordedOrder(sort()) ? ordered() : ordered().slice(0, own().shown));
            const hasMore = () => !own().loaded || (isRecordedOrder(sort()) ? own().more : own().shown < own().rows.length);
            return (
              <tbody>
                <tr class="group-row day-row">
                  <td colSpan={REQUEST_COLUMN_COUNT}>
                    <button type="button" class="day-toggle" aria-expanded={isOpen(day)} onClick={() => toggle(day)}>
                      <Show when={isOpen(day)} fallback={<ChevronRight size={CHEVRON_PX} />}>
                        <ChevronDown size={CHEVRON_PX} />
                      </Show>
                      <span>{dayName(day)}</span>
                      <Show when={isOlder(day)}><span class="badge compact accent" title="Older than local retention; read from ClickHouse">ClickHouse</span></Show>
                      <span class="muted">
                        {(summary()?.requests ?? 0).toLocaleString(appLocale())} requests · {(summary()?.failed ?? 0).toLocaleString(appLocale())} failed
                        {/* ClickHouse day summaries count requests only. */}
                        <Show when={!isOlder(day)}> · {summary() ? costText(summary()!) : '—'}</Show>
                      </span>
                    </button>
                  </td>
                </tr>
                <Show when={isOpen(day)}>
                  <For each={rows()}>{(e) => <RequestRow e={e} account={props.account} />}</For>
                  <Show when={own().error}>
                    {(message) => <tr><td colSpan={REQUEST_COLUMN_COUNT} class="older-note">ClickHouse is unavailable, so this day's requests can't be shown. {message()}</td></tr>}
                  </Show>
                  <Show when={own().truncated}>
                    <tr><td colSpan={REQUEST_COLUMN_COUNT} class="older-note">ClickHouse's row limit was reached, so this day's oldest requests are missing.</td></tr>
                  </Show>
                  <Show when={hasMore()}>
                    <tr>
                      <td class="more-cell" colSpan={REQUEST_COLUMN_COUNT} ref={(el) => watchEnd(el, day)}>
                        <button type="button" class="btn ghost" disabled={own().loading} onClick={() => loadMore(day)}>
                          {own().loading ? 'Loading…' : 'Show more'}
                        </button>
                      </td>
                    </tr>
                  </Show>
                  <Show when={own().loaded && own().rows.length === 0}>
                    <tr><td colSpan={REQUEST_COLUMN_COUNT} class="muted">No requests.</td></tr>
                  </Show>
                </Show>
              </tbody>
            );
          }}
        </For>
        <Show when={older.enabled()}>
          <tbody>
            <tr>
              <td class="more-cell" colSpan={REQUEST_COLUMN_COUNT}>
                <div class="older-days">
                  <Show when={older.error()}>
                    {(message) => <span class="older-note">ClickHouse is unavailable, so older requests can't be shown. {message()}</span>}
                  </Show>
                  <Show when={!older.exhausted()} fallback={<span class="muted">No earlier requests in ClickHouse.</span>}>
                    <span class="muted">
                      {older.from() ? `Read from ClickHouse back to ${dayLabel(older.from()!)}.` : 'Requests older than local retention are kept in ClickHouse.'}
                    </span>
                    <button type="button" class="btn ghost" disabled={older.loading()} onClick={() => older.load()}>
                      {older.loading() ? 'Loading…' : older.error() ? 'Retry' : `Show ${OLDER_DAYS_WINDOW} earlier days`}
                    </button>
                  </Show>
                </div>
              </td>
            </tr>
          </tbody>
        </Show>
      </table>
      </div>
    </div>
  );
}
