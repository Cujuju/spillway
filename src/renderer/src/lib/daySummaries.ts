import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { localDay } from '@shared/activityCounts';
import { inScope, type AccountScope } from '@shared/activityScope';
import { tokenCost } from '@shared/modelPrices';
import type { ActivityDaySummary, StoredActivityEvent } from '@shared/types';

const withRequest = (s: ActivityDaySummary, e: StoredActivityEvent): ActivityDaySummary => {
  const cost = tokenCost(e.provider, e.model, e);
  return {
    ...s, requests: s.requests + 1, failed: s.failed + (e.failed ? 1 : 0), newestId: e.id,
    costUsd: s.costUsd + (cost?.usd ?? 0), unpricedRequests: s.unpricedRequests + (cost ? 0 : 1),
  };
};

export interface DaySummaries {
  /** Newest day first. */
  list: () => ActivityDaySummary[];
  byDay: () => Map<string, ActivityDaySummary>;
  /** Totals across every stored day, for the accounts shown. */
  stored: () => { requests: number; failed: number };
  loaded: () => boolean;
}

/** Per-day request counts for `accounts`, loaded when they change and kept current from the live stream. Call in a component. */
export function createDaySummaries(accounts: () => AccountScope): DaySummaries {
  const [list, setList] = createSignal<ActivityDaySummary[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  /** Live requests that arrive while a load runs; applied after, when newer than it counted. */
  let liveDuringLoad: StoredActivityEvent[] | null = [];
  /** Bumped per load; only the newest load, for the current accounts, applies. */
  let generation = 0;
  const byDay = createMemo(() => new Map(list().map((s) => [s.day, s])));
  const stored = createMemo(() => list().reduce((t, s) => ({ requests: t.requests + s.requests, failed: t.failed + s.failed }), { requests: 0, failed: 0 }));

  const count = (e: StoredActivityEvent) => {
    if (!inScope(accounts(), e.authIndex)) return;
    const day = localDay(Date.parse(e.at));
    const current = byDay().get(day);
    if (current && e.id <= current.newestId) return;
    const next = withRequest(current ?? { day, requests: 0, failed: 0, costUsd: 0, unpricedRequests: 0, newestId: 0 }, e);
    setList((all) => (current ? all.map((s) => (s.day === day ? next : s)) : [next, ...all].sort((a, b) => b.day.localeCompare(a.day))));
  };

  onMount(() => {
    // An IPC event handler: it reads current state on each event, untracked by design.
    // oxlint-disable-next-line solid/reactivity
    onCleanup(window.api.onActivity((e) => (liveDuringLoad ? liveDuringLoad.push(e) : count(e))));
  });
  createEffect(on(accounts, (scope) => {
    const gen = ++generation;
    liveDuringLoad ??= [];
    setLoaded(false);
    void window.api
      .activityDaySummaries(scope)
      .then((next) => {
        if (gen === generation) setList(next);
      })
      .catch((err: unknown) => {
        console.error('[activity] day summaries failed:', err);
        // Never show another account choice's counts.
        if (gen === generation) setList([]);
      })
      .finally(() => {
        if (gen !== generation) return;
        for (const e of liveDuringLoad ?? []) count(e);
        liveDuringLoad = null;
        setLoaded(true);
      });
  }));

  return { list, byDay, stored, loaded };
}
