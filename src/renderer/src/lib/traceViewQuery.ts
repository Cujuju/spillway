import type { TraceCoverage, TraceQuery } from '@shared/sessionTrace';

/** Live refresh advances the window; pagination and inspection pin the last returned bounds. */
export function traceViewQuery(q: TraceQuery, pinned?: Pick<TraceCoverage, 'from' | 'to'>, now = Date.now()): TraceQuery {
  const to = pinned?.to ?? q.to ?? new Date(now).toISOString();
  const from = pinned?.from ?? q.from ?? new Date(Date.parse(to) - 7 * 86_400_000).toISOString();
  return { ...q, from, to };
}
