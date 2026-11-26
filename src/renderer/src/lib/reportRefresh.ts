import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js';
import { liveActivityVersion } from '../store';

export const REPORT_REFRESH_MS = 60_000;

/**
 * Emits report queries only while active and visible: immediately on user param changes,
 * at most once per minute on live traffic or resets, and deferred while hidden until reveal.
 */
export function createReportQuery<P, Q>(
  active: Accessor<boolean>,
  params: Accessor<P>,
  readQuery: (params: P) => Q,
): Accessor<Q | false> {
  const [query, setQuery] = createSignal<Q | false>(false);
  createEffect(() => {
    if (!active()) {
      setQuery(false);
      return;
    }
    const doc = typeof document === 'undefined' ? undefined : document;
    let lastVersion = untrack(liveActivityVersion);
    let lastFetch = 0;
    let paramsDirty = false;
    let trafficDirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { clearTimeout(timer); timer = undefined; };
    const emit = () => {
      cancel();
      paramsDirty = false;
      trafficDirty = false;
      lastVersion = untrack(liveActivityVersion);
      lastFetch = Date.now();
      const next = untrack(() => readQuery(params()));
      setQuery(() => next);
    };
    const scheduleTraffic = () => {
      if (doc?.hidden || !trafficDirty) return;
      timer ??= setTimeout(() => { if (!doc?.hidden && (paramsDirty || trafficDirty)) emit(); }, Math.max(0, lastFetch + REPORT_REFRESH_MS - Date.now()));
    };
    const visibilityChanged = () => {
      if (doc?.hidden) { cancel(); return; }
      if (paramsDirty) emit();
      else if (trafficDirty) scheduleTraffic();
    };
    doc?.addEventListener('visibilitychange', visibilityChanged);
    onCleanup(() => { cancel(); doc?.removeEventListener('visibilitychange', visibilityChanged); });

    createEffect(() => {
      params();
      if (doc?.hidden) {
        cancel();
        paramsDirty = true;
        return;
      }
      emit();
    });

    createEffect(on(liveActivityVersion, (version) => {
      if (version === lastVersion) return;
      trafficDirty = true;
      scheduleTraffic();
    }, { defer: true }));
  });
  return query;
}
