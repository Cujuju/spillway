import type { StoredActivityEvent } from '@shared/types';

/** Rows mounted per reveal step so opening a busy day never blocks a paint frame. */
export const REQUEST_RENDER_BATCH = 100;

/** Reuses unchanged row objects by ID so Solid `<For>` keeps mounted rows and open inspectors intact. */
export function reconcileRows(existing: StoredActivityEvent[], incoming: StoredActivityEvent[]): StoredActivityEvent[] {
  if (!existing.length) return incoming;
  const byId = new Map(existing.map((e) => [e.id, e]));
  return incoming.map((next) => {
    const prev = byId.get(next.id);
    return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
  });
}

/** Keeps every surviving previously visible row revealed in the refreshed display order. */
export function refreshedShownCount(
  previousOrdered: readonly StoredActivityEvent[],
  currentShown: number,
  nextOrdered: readonly StoredActivityEvent[],
  minBatch = REQUEST_RENDER_BATCH,
): number {
  const visible = new Set(previousOrdered.slice(0, currentShown).map((r) => r.id));
  let lastIndex = -1;
  for (let i = 0; i < nextOrdered.length; i++) {
    if (visible.has(nextOrdered[i]!.id)) lastIndex = i;
  }
  return Math.max(currentShown, lastIndex + 1, minBatch);
}

/** Merges live events buffered during a refresh ahead of fetched rows without duplicating IDs. */
export function mergeRefreshedRows(fetched: StoredActivityEvent[], buffered: StoredActivityEvent[]): StoredActivityEvent[] {
  if (!buffered.length) return fetched;
  const seen = new Set(fetched.map((e) => e.id));
  const extra = buffered.filter((e) => !seen.has(e.id));
  if (!extra.length) return fetched;
  const deduped = [...new Map(extra.map((e) => [e.id, e])).values()].sort((a, b) => b.id - a.id);
  return [...deduped, ...fetched];
}
