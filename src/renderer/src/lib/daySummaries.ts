import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { localDay } from '@shared/activityCounts';
import { inScope, type ActivityScope } from '@shared/activityScope';
import { tokenCost } from '@shared/modelPrices';
import type { ActivityDaySummary, StoredActivityEvent } from '@shared/types';

const withRequest = (s: ActivityDaySummary, e: StoredActivityEvent): ActivityDaySummary => {
  const cost = tokenCost(e.provider, e.effectiveModel ?? e.model, e.at, e);
  return {
    ...s, requests: s.requests + 1, failed: s.failed + (e.failed ? 1 : 0), newestId: e.id,
    costUsd: s.costUsd + (cost?.usd ?? 0), unpricedRequests: s.unpricedRequests + (cost ? 0 : 1),
  };
};

export interface DaySummaries {
  /** Newest day first. */
  list: () => ActivityDaySummary[];
  byDay: () => Map<string, ActivityDaySummary>;
  /** Totals across every stored day, for the requests shown. */
  stored: () => { requests: number; failed: number };
  loaded: () => boolean;
  /** Bumps on visible activity resets (or once on reveal after hidden resets) so open day sections refresh in place. */
  resetCount: () => number;
}

/** Per-day request counts for `scope`, loaded only while `active` and kept current from the live stream. Call in a component. */
export function createDaySummaries(active: () => boolean, scope: () => ActivityScope): DaySummaries {
  const [list, setList] = createSignal<ActivityDaySummary[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  /** Live requests that arrive while a load runs; applied after, when newer than it counted. */
  let liveDuringLoad: StoredActivityEvent[] | null = [];
  /** Bumped per load; only the newest load, for the current scope, applies. */
  let generation = 0;
  const byDay = createMemo(() => new Map(list().map((s) => [s.day, s])));
  const stored = createMemo(() => list().reduce((t, s) => ({ requests: t.requests + s.requests, failed: t.failed + s.failed }), { requests: 0, failed: 0 }));

  const count = (e: StoredActivityEvent) => {
    if (!active() || !inScope(scope(), e)) return;
    const day = localDay(Date.parse(e.at));
    const current = byDay().get(day);
    if (current && e.id <= current.newestId) return;
    const next = withRequest(current ?? { day, requests: 0, failed: 0, costUsd: 0, unpricedRequests: 0, newestId: 0 }, e);
    setList((all) => (current ? all.map((s) => (s.day === day ? next : s)) : [next, ...all].sort((a, b) => b.day.localeCompare(a.day))));
  };

  const [reloadTick, setReloadTick] = createSignal(0);
  const [resetTick, setResetTick] = createSignal(0);
  let pendingReload = false;
  let pendingReset = false;
  const isHidden = () => typeof document !== 'undefined' && document.hidden;

  onMount(() => {
    // An IPC event handler: it reads current state on each event, untracked by design.
    // oxlint-disable-next-line solid/reactivity
    onCleanup(window.api.onActivity((e) => {
      if (!active()) return;
      if (isHidden()) { pendingReload = true; return; }
      if (liveDuringLoad) liveDuringLoad.push(e);
      else count(e);
    }));
    // oxlint-disable-next-line solid/reactivity
    onCleanup(window.api.onActivityReset(() => {
      if (!active()) return;
      if (isHidden()) { pendingReload = true; pendingReset = true; return; }
      setResetTick((n) => n + 1);
    }));
    const onVisibility = () => {
      if (isHidden() || !active()) return;
      if (pendingReset) {
        pendingReset = false;
        pendingReload = false;
        setResetTick((n) => n + 1);
      } else if (pendingReload) {
        pendingReload = false;
        setReloadTick((n) => n + 1);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
      onCleanup(() => document.removeEventListener('visibilitychange', onVisibility));
    }
  });
  createEffect(on([active, scope, reloadTick, resetTick], ([isActive, current]) => {
    if (!isActive) {
      pendingReload = false;
      pendingReset = false;
      generation += 1;
      liveDuringLoad = null;
      return;
    }
    if (isHidden()) {
      generation += 1;
      liveDuringLoad = null;
      pendingReload = true;
      return;
    }
    pendingReload = false;
    pendingReset = false;
    const gen = ++generation;
    liveDuringLoad ??= [];
    setLoaded(false);
    void window.api
      .activityDaySummaries(current)
      .then((next) => {
        if (gen === generation) setList(next);
      })
      .catch((err: unknown) => {
        console.error('[activity] day summaries failed:', err);
        // Never show another filter's counts.
        if (gen === generation) setList([]);
      })
      .finally(() => {
        if (gen !== generation) return;
        for (const e of liveDuringLoad ?? []) count(e);
        liveDuringLoad = null;
        setLoaded(true);
      });
  }));

  return { list, byDay, stored, loaded, resetCount: resetTick };
}
