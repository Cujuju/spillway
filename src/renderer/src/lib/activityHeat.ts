import type { ActivityBucket } from '@shared/types';
import { bucketStarts, bucketUnit, floorTo, type Span } from './activityRange';
import { metricValue, series, summarize, type Metric, type Summary } from './activityStats';

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const HOURS = Array.from({ length: HOURS_PER_DAY }, (_, h) => h);

const inSpan = (r: ActivityBucket, s: Span) => r.start >= s.from && r.start <= s.to;
/** Daily totals carry no hour, so hour views leave them out. */
const hourly = (rows: ActivityBucket[], s: Span) => rows.filter((r) => !r.wholeDay && inSpan(r, s));

export interface HourRow {
  label: string;
  /** Local hour of each cell. */
  hours: number[];
  cells: Summary[];
}

/** A 24-hour span is one row of its hours; up to two weeks, one row per local day. Longer spans use the calendar. */
export type HeatShape = 'hours' | 'days' | 'calendar';
export function heatShape(s: Span): HeatShape {
  const unit = bucketUnit(s);
  return unit === 'hour' ? 'hours' : unit === '3h' ? 'days' : 'calendar';
}

export function hourRows(rows: ActivityBucket[], s: Span): HourRow[] {
  const kept = hourly(rows, s);
  if (heatShape(s) === 'hours') {
    const points = series(kept, bucketStarts(s, 'hour'), s.to);
    return [{ label: '', hours: points.map((p) => new Date(p.start).getHours()), cells: points.map((p) => p.summary) }];
  }
  return bucketStarts(s, 'day').map((day) => {
    const date = new Date(day).toDateString();
    const byHour = HOURS.map(() => [] as ActivityBucket[]);
    for (const r of kept) if (new Date(r.start).toDateString() === date) byHour[new Date(r.start).getHours()]!.push(r);
    return { label: new Date(day).toLocaleDateString(undefined, { weekday: 'short' }), hours: HOURS, cells: byHour.map(summarize) };
  });
}

export interface CalendarWeek {
  start: number;
  /** Monday first; null outside the span. */
  days: (Summary | null)[];
}

/** One cell per local day, weeks as columns (GitHub style). Daily totals count: the day is known. */
export function calendarWeeks(rows: ActivityBucket[], s: Span): CalendarWeek[] {
  const byDay = new Map<string, ActivityBucket[]>();
  for (const r of rows) {
    if (!inSpan(r, s)) continue;
    const key = new Date(r.start).toDateString();
    const list = byDay.get(key);
    if (list) list.push(r);
    else byDay.set(key, [r]);
  }
  const first = floorTo(s.from, 'day');
  return bucketStarts(s, 'week').map((start) => ({
    start,
    days: Array.from({ length: DAYS_PER_WEEK }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d.getTime() < first || d.getTime() > s.to ? null : summarize(byDay.get(d.toDateString()) ?? []);
    }),
  }));
}

/** Each local clock hour summed over the span; repeated DST hours both count. */
export function hourOfDay(rows: ActivityBucket[], s: Span, metric: Metric) {
  const kept = hourly(rows, s);
  const hours = HOURS.map((h) => summarize(kept.filter((r) => new Date(r.start).getHours() === h)));
  const max = Math.max(0, ...hours.map((c) => metricValue(c, metric)));
  // Earliest hour wins a tie; an empty or unpriced-only metric has no peak.
  const peak = max > 0 ? hours.findIndex((c) => metricValue(c, metric) === max) : null;
  const undetailedDays = new Set(rows.filter((r) => r.wholeDay && inSpan(r, s)).map((r) => r.start)).size;
  return { hours, max, peak, total: summarize(kept), undetailedDays };
}
