import type { ActivityBucket } from '@shared/types';
import type { Span } from './activityRange';
import { metricValue, summarize, type Metric } from './activityStats';

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const HOURS = Array.from({ length: HOURS_PER_DAY }, (_, h) => h);

const inSpan = (r: ActivityBucket, s: Span) => r.start >= s.from && r.start <= s.to;
/** Daily totals carry no hour, so hour views leave them out. */
const hourly = (rows: ActivityBucket[], s: Span) => rows.filter((r) => !r.wholeDay && inSpan(r, s));

/** Weekday index with Monday first, matching the heatmap's rows. */
const mondayFirst = (t: number) => (new Date(t).getDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;

/** Days in the span held only as daily totals, so hour views can say what they leave out. */
const undetailedDays = (rows: ActivityBucket[], s: Span) => new Set(rows.filter((r) => r.wholeDay && inSpan(r, s)).map((r) => r.start)).size;

/** Each weekday's local clock hours summed over the span: always 7 rows (Monday first) of 24 cells. */
export function weekdayHours(rows: ActivityBucket[], s: Span) {
  const byCell = Array.from({ length: DAYS_PER_WEEK }, () => HOURS.map(() => [] as ActivityBucket[]));
  for (const r of hourly(rows, s)) byCell[mondayFirst(r.start)]![new Date(r.start).getHours()]!.push(r);
  return { days: byCell.map((hours) => hours.map(summarize)), undetailedDays: undetailedDays(rows, s) };
}

/** Each local clock hour summed over the span; repeated DST hours both count. */
export function hourOfDay(rows: ActivityBucket[], s: Span, metric: Metric) {
  const kept = hourly(rows, s);
  const byHour = HOURS.map(() => [] as ActivityBucket[]);
  for (const r of kept) byHour[new Date(r.start).getHours()]!.push(r);
  const hours = byHour.map(summarize);
  const max = Math.max(0, ...hours.map((c) => metricValue(c, metric)));
  // Earliest hour wins a tie; an empty or unpriced-only metric has no peak.
  const peak = max > 0 ? hours.findIndex((c) => metricValue(c, metric) === max) : null;
  return { hours, max, peak, total: summarize(kept), undetailedDays: undetailedDays(rows, s) };
}
