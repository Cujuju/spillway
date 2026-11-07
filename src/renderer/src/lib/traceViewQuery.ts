import type { TraceCoverage, TraceQuery } from '@shared/sessionTrace';
import { rangeSpan, type CustomRange, type Range } from './activityRange';

/** The Traces time frame: a preset ending now, or inclusive local days. */
export interface TraceWindow { range: Range; custom: CustomRange }

/** The window at `now`, so a refresh advances a preset; pagination and inspection pin the last returned bounds. */
export function traceViewQuery(q: TraceQuery, window: TraceWindow, pinned?: Pick<TraceCoverage, 'from' | 'to'>, now = Date.now()): TraceQuery {
  const span = rangeSpan(window.range, now, window.custom, null);
  return { ...q, from: pinned?.from ?? new Date(span.from).toISOString(), to: pinned?.to ?? new Date(span.to).toISOString() };
}
