import { batch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, untrack, type Accessor } from 'solid-js';
import type { OlderBuckets, OlderPage, OlderPageQuery, OlderRead } from '@shared/activityOlder';
import type { ActivityScope } from '@shared/activityScope';
import type { ActivityDaySummary } from '@shared/types';
import { dayText, type Span } from './activityRange';

/** A ClickHouse read that returned no data; its message is safe to show. */
export class OlderReadError extends Error {}

const OFF_MESSAGE = 'ClickHouse export is off.';
const failed = (err: unknown): { state: 'unavailable'; error: string } => {
  console.error('[activity] ClickHouse read failed:', err);
  return { state: 'unavailable', error: 'The read failed.' };
};

/** Totals older than the local data for the span's start; reloads when that start or the local data changes. Call in a component. */
export function createOlderBuckets(span: Accessor<Span>): Accessor<OlderRead<OlderBuckets> | undefined> {
  const [resets, setResets] = createSignal(0);
  onCleanup(window.api.onActivityReset(() => setResets((n) => n + 1)));
  // A span ending at "now" moves every tick; only its start and last day change what is read.
  const key = createMemo(() => `${span().from}|${dayText(span().to)}|${resets()}`);
  const [read] = createResource(key, () => window.api.activityOlderBuckets(untrack(span)).catch(failed));
  return () => read.latest;
}

/** One page of a ClickHouse day; throws OlderReadError when the store is off or unavailable. */
export async function olderPage(query: OlderPageQuery): Promise<OlderPage> {
  const read = await window.api.activityOlderPage(query).catch(failed);
  if (read.state === 'ok') return read;
  throw new OlderReadError(read.state === 'off' ? OFF_MESSAGE : read.error);
}

export interface OlderDayList {
  /** ClickHouse is configured, so older days can be asked for. */
  enabled: () => boolean;
  /** Days read so far, newest first. */
  list: () => ActivityDaySummary[];
  byDay: () => Map<string, ActivityDaySummary>;
  loading: () => boolean;
  /** Why the last read returned nothing. */
  error: () => string | null;
  /** First local day read so far; null before the first read. */
  from: () => string | null;
  /** Every older day has been read. */
  exhausted: () => boolean;
  /** Reads the next window of older days. */
  load: () => void;
}

/** Days older than local retention, read from ClickHouse a window at a time on request; starts over when `scope` changes. Call in a component. */
export function createOlderDays(scope: Accessor<ActivityScope>): OlderDayList {
  const [enabled, setEnabled] = createSignal(false);
  const [list, setList] = createSignal<ActivityDaySummary[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [from, setFrom] = createSignal<string | null>(null);
  const [earlier, setEarlier] = createSignal(true);
  /** Bumped when the scope changes, so a read started under the old one is dropped. */
  let generation = 0;
  const byDay = createMemo(() => new Map(list().map((s) => [s.day, s])));

  onMount(() => {
    void window.api.clickhouseStatus()
      .then((s) => setEnabled(s.config.enabled && s.config.endpoint !== ''))
      .catch((err: unknown) => console.error('[activity] ClickHouse status failed:', err));
  });
  // The page rebuilds its scope object on every activity reset; only changed filters start over.
  const filters = createMemo(() => JSON.stringify(scope()));
  createEffect(on(filters, () => {
    generation += 1;
    batch(() => { setList([]); setLoading(false); setError(null); setFrom(null); setEarlier(true); });
  }, { defer: true }));

  const load = () => {
    if (loading()) return;
    const gen = generation;
    setLoading(true);
    void window.api.activityOlderDays({ scope: scope(), before: from() }).catch(failed).then((read) => {
      if (gen !== generation) return;
      batch(() => {
        setLoading(false);
        if (read.state === 'off') { setEnabled(false); return; }
        if (read.state === 'unavailable') { setError(read.error); return; }
        setError(null);
        setList((days) => [...days, ...read.days]);
        setFrom(read.from);
        setEarlier(read.earlier);
      });
    });
  };

  return { enabled, list, byDay, loading, error, from, exhausted: () => !earlier(), load };
}
