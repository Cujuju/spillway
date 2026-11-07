import type { ArchiveQuery } from '@shared/archive';
import { rangeSpan } from './activityRange';
import type { TraceWindow } from './traceViewQuery';

/** The Archive's own filters; the time frame is the scope sentence's last phrase. */
export type ArchiveFilters = Omit<ArchiveQuery, 'from' | 'to' | 'before'>;
/** A patch that clears every filter. */
export const RESET_ARCHIVE_FILTERS: { [K in keyof Required<ArchiveFilters>]: undefined } = {
  text: undefined, sessionId: undefined, provider: undefined, model: undefined, client: undefined, state: undefined,
};
export const archiveFiltersNarrowed = (f: ArchiveFilters) => Object.values(f).some(Boolean);

/** The query at `now`. Presets end now and stay open, so records arriving after the query still match; custom days end with their last day. */
export function archiveViewQuery(f: ArchiveFilters, window: TraceWindow, now = Date.now()): ArchiveQuery {
  if (window.range === 'all') return { ...f };
  const span = rangeSpan(window.range, now, window.custom, null);
  return { ...f, from: new Date(span.from).toISOString(), ...(window.range === 'custom' ? { to: new Date(span.to).toISOString() } : {}) };
}
