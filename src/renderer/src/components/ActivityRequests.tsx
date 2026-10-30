import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-solid';
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { localDay } from '@shared/activityCounts';
import { inScope, type ActivityScope } from '@shared/activityScope';
import { ACTIVITY_PAGE_SIZE, type StoredActivityEvent } from '@shared/types';
import type { DaySummaries } from '../lib/daySummaries';
import { conversationLabel } from '../lib/conversationNames';
import { dayLabel } from '../lib/format';
import { persistedSignal } from '../lib/persisted';
import { DEFAULT_SORT, isRecordedOrder, isRequestSort, nextSort, REQUEST_COLUMNS, sortRequests, type RequestSort } from '../lib/requestSort';
import { now } from '../store';
import { costText } from './activityFormat';
import { REQUEST_COLUMN_COUNT, RequestRow } from './RequestRow';

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
}
const NEW_SECTION: Section = { rows: [], more: false, loaded: false, loading: false, shown: 0 };

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
  // Day strings keep each section's rows mounted while its summary updates.
  const shownDays = createMemo(() => props.days.list().filter((s) => !failedOnly() || s.failed > 0).map((s) => s.day));

  createEffect(on([() => props.filter, () => props.scope, sort], () => {
    generation += 1;
    setSections({});
  }, { defer: true }));
  // Forget open/closed choices for days no longer stored. Only the unfiltered list holds every stored day.
  createEffect(on(() => props.days.loaded(), (loaded) => {
    if (!loaded || props.scope.accounts !== null || props.scope.clients !== null || props.scope.source === 'proxy') return;
    const days = props.days.byDay();
    setToggled((t) => Object.fromEntries(Object.entries(t).filter(([d]) => days.has(d))));
  }));

  const fetchInto = (day: string, load: () => Promise<{ events: StoredActivityEvent[]; more: boolean }>) => {
    const gen = generation;
    setSection(day, (cur) => ({ ...cur, loading: true }));
    void load()
      .then((page) => {
        if (gen !== generation) return;
        // Live requests that arrived during the load may be in it too.
        setSection(day, (cur) => {
          const shown = new Set(cur.rows.map((e) => e.id));
          return { ...cur, rows: [...cur.rows, ...page.events.filter((e) => !shown.has(e.id))], more: page.more, loaded: true, loading: false, shown: ACTIVITY_PAGE_SIZE };
        });
      })
      .catch((err: unknown) => {
        console.error('[activity] requests failed to load:', err);
        if (gen === generation) setSection(day, (cur) => ({ ...cur, loading: false }));
      });
  };
  /** Newest first pages from the database; other orders load the whole day once, then reveal it a page at a time. */
  const loadMore = (day: string) => {
    const s = section(day);
    if (s.loading) return;
    // Read now, so the load matches the filters it started under.
    const failed = failedOnly();
    const scope = props.scope;
    if (isRecordedOrder(sort())) {
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
            const summary = () => props.days.byDay().get(day);
            // Same object until this day's section changes, so other days' updates don't re-sort it.
            const own = createMemo(() => section(day));
            const rows = createMemo(() => (isRecordedOrder(sort()) ? own().rows : sortRequests(own().rows, sort(), { account: props.account, conversation: conversationLabel }).slice(0, own().shown)));
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
                      <span class="muted">
                        {(summary()?.requests ?? 0).toLocaleString()} requests · {(summary()?.failed ?? 0).toLocaleString()} failed · {summary() ? costText(summary()!) : '—'}
                      </span>
                    </button>
                  </td>
                </tr>
                <Show when={isOpen(day)}>
                  <For each={rows()}>{(e) => <RequestRow e={e} account={props.account} />}</For>
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
      </table>
    </div>
  );
}
