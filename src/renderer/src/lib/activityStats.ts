import type { ActivityMetric } from '@shared/activityBoard';
import { addCounts, emptyCounts, localHourStart } from '@shared/activityCounts';
import { accountKey, clientKey } from '@shared/activityScope';
import { promptTokens } from '@shared/modelPrices';
import type { ActivityBucket, ActivityCounts } from '@shared/types';

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const HOUR_MS = 60 * 60 * 1000;

export type Range = '24h' | '7d' | '30d';
export type Metric = ActivityMetric;

interface RangeSpec {
  /** Bars in the trend chart. */
  buckets: number;
  /** Local hours per bar; a whole day when 24. */
  hoursPerBucket: number;
}

/** Hourly bars resolve a day; 3-hour bars keep a week legible (56); daily bars for a month. */
export const RANGES: Record<Range, RangeSpec> = {
  '24h': { buckets: 24, hoursPerBucket: 1 },
  '7d': { buckets: 56, hoursPerBucket: 3 },
  '30d': { buckets: 30, hoursPerBucket: HOURS_PER_DAY },
};

/** Local days of data a range needs, counting the partial day at each end. */
export const rangeDays = (range: Range) => Math.ceil((RANGES[range].buckets * RANGES[range].hoursPerBucket) / HOURS_PER_DAY) + 1;

export interface Summary extends ActivityCounts {
  /** Tokens the model read, cached or not. */
  promptTokens: number;
  /** Prompt plus output tokens. */
  totalTokens: number;
  /** Share of prompt tokens served from cache; null with no prompt tokens. */
  cacheHitRate: number | null;
}

export function summarize(rows: ActivityBucket[]): Summary {
  const c = emptyCounts();
  let prompt = 0;
  for (const r of rows) {
    addCounts(c, r);
    prompt += promptTokens(r.provider, r);
  }
  return { ...c, promptTokens: prompt, totalTokens: prompt + c.outputTokens, cacheHitRate: prompt > 0 ? c.cachedTokens / prompt : null };
}

export const metricValue = (s: Summary, m: Metric) => (m === 'cost' ? s.costUsd : m === 'tokens' ? s.totalTokens : s.requests);

/** Start of the local bucket holding `t`. */
function floorToBucket(t: number, hoursPerBucket: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  d.setHours(hoursPerBucket >= HOURS_PER_DAY ? 0 : d.getHours() - (d.getHours() % hoursPerBucket));
  return d.getTime();
}

/** Oldest first; hourly ranges step in elapsed time, longer ranges follow local calendar boundaries. */
export function bucketStarts(range: Range, now: number): number[] {
  const { buckets, hoursPerBucket } = RANGES[range];
  if (hoursPerBucket === 1) {
    const last = localHourStart(now);
    return Array.from({ length: buckets }, (_, i) => last - (buckets - 1 - i) * HOUR_MS);
  }
  const last = new Date(floorToBucket(now, hoursPerBucket));
  return Array.from({ length: buckets }, (_, i) => {
    const d = new Date(last);
    if (hoursPerBucket >= HOURS_PER_DAY) d.setDate(d.getDate() - (buckets - 1 - i));
    else d.setHours(d.getHours() - (buckets - 1 - i) * hoursPerBucket);
    return d.getTime();
  });
}

export interface SeriesPoint {
  start: number;
  end: number;
  summary: Summary;
}

/** Sums rows into the range's buckets; rows before the first bucket are left out. */
export function series(rows: ActivityBucket[], starts: number[], now: number): SeriesPoint[] {
  const groups = starts.map(() => [] as ActivityBucket[]);
  for (const r of rows) {
    if (r.start < starts[0]!) continue;
    let i = starts.length - 1;
    while (i > 0 && starts[i]! > r.start) i--;
    groups[i]!.push(r);
  }
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? now, summary: summarize(groups[i]!) }));
}

/** The latest 24 elapsed local hours, excluding daily totals and future activity. */
export function hourlySeries(rows: ActivityBucket[], now: number): SeriesPoint[] {
  return series(rows.filter((r) => !r.wholeDay && r.start <= now), bucketStarts('24h', now), now);
}

export const inRange = (rows: ActivityBucket[], starts: number[]) => rows.filter((r) => r.start >= starts[0]!);

export interface ModelRow {
  provider: string;
  model: string;
  summary: Summary;
}

export interface AccountRow {
  provider: string;
  authIndex: string | null;
  summary: Summary;
}

/** Sums rows sharing a key, costliest first, then by tokens; `first` is any row of the group. */
function groupSummaries(rows: ActivityBucket[], keyOf: (r: ActivityBucket) => string): { first: ActivityBucket; summary: Summary }[] {
  const groups = new Map<string, ActivityBucket[]>();
  for (const r of rows) {
    const key = keyOf(r);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()]
    .map((g) => ({ first: g[0]!, summary: summarize(g) }))
    .sort((a, b) => b.summary.costUsd - a.summary.costUsd || b.summary.totalTokens - a.summary.totalTokens);
}

/** Per provider and model, costliest first, then by tokens. */
export const byModel = (rows: ActivityBucket[]): ModelRow[] =>
  groupSummaries(rows, (r) => `${r.provider}|${r.model}`).map(({ first, summary }) => ({ provider: first.provider, model: first.model, summary }));

/** One client's totals in the range. */
export interface ClientRow {
  client: string | null;
  summary: Summary;
}

/** Per client, costliest first, then by tokens. */
export const byClient = (rows: ActivityBucket[]): ClientRow[] =>
  groupSummaries(rows, (r) => clientKey(r.client)).map(({ first, summary }) => ({ client: first.client, summary }));

/** Per account, costliest first, then by tokens. An authIndex belongs to one provider. */
export const byAccount = (rows: ActivityBucket[]): AccountRow[] =>
  groupSummaries(rows, (r) => accountKey(r.authIndex)).map(({ first, summary }) => ({ provider: first.provider, authIndex: first.authIndex, summary }));

export const HEAT_MODES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'week', label: '7 days' },
  { value: 'lastWeek', label: 'Last week' },
  { value: 'rhythm', label: 'Rhythm', title: 'Time of day, summed over stored hourly activity' },
] as const;
export type HeatMode = (typeof HEAT_MODES)[number]['value'];

const DAY_BANDS = [
  { name: 'Morning', startHour: 6, endHour: 12 },
  { name: 'Afternoon', startHour: 12, endHour: 18 },
  { name: 'Evening', startHour: 18, endHour: HOURS_PER_DAY },
  { name: 'Night', startHour: 0, endHour: 6 },
] as const;

/** All supplied hourly history, grouped by local clock; repeated DST hours both count. */
export function rhythmStats(rows: ActivityBucket[], metric: Metric, now: number) {
  const hourly = rows.filter((r) => !r.wholeDay && r.start <= now);
  const bands = DAY_BANDS.map((band) => ({ ...band, summary: summarize(hourly.filter((r) => {
    const hour = new Date(r.start).getHours();
    return hour >= band.startHour && hour < band.endHour;
  })) }));
  const max = Math.max(0, ...bands.map((b) => metricValue(b.summary, metric)));
  // Stable display order breaks ties; empty or unpriced-only metrics have no peak.
  const peak = max > 0 ? bands.find((b) => metricValue(b.summary, metric) === max)! : null;
  const first = hourly.reduce((earliest, r) => Math.min(earliest, r.start), now);
  const dayNumber = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (HOUR_MS * HOURS_PER_DAY);
  };
  return { bands, peak, max, total: summarize(hourly), days: hourly.length ? dayNumber(now) - dayNumber(first) + 1 : 0 };
}

export interface HeatRow {
  label: string;
  hours: number[];
  /** Summaries in the same order as hours. */
  cells: Summary[];
}

/** Monday-first weekday order for the rhythm view. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const weekday = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short' });

/**
 * Local-hour grids exclude daily totals: their hour is unknown. Rhythm sums stored hours by weekday.
 */
export function heatGrid(rows: ActivityBucket[], mode: HeatMode, now: number): HeatRow[] {
  const hourly = rows.filter((r) => !r.wholeDay && r.start <= now);
  const hours = Array.from({ length: HOURS_PER_DAY }, (_, h) => h);
  if (mode === 'hourly') {
    const points = hourlySeries(rows, now);
    return [{ label: '24h', hours: points.map((p) => new Date(p.start).getHours()),
      cells: points.map((p) => p.summary) }];
  }
  const cellsOf = (match: (d: Date) => boolean) => {
    const byHour = Array.from({ length: HOURS_PER_DAY }, () => [] as ActivityBucket[]);
    for (const r of hourly) {
      const d = new Date(r.start);
      if (match(d)) byHour[d.getHours()]!.push(r);
    }
    return byHour.map(summarize);
  };
  if (mode === 'rhythm') {
    return WEEKDAYS.map((wd) => {
      const sample = new Date(now);
      sample.setDate(sample.getDate() - ((sample.getDay() - wd + DAYS_PER_WEEK) % DAYS_PER_WEEK));
      return { label: weekday(sample), hours, cells: cellsOf((d) => d.getDay() === wd) };
    });
  }
  return Array.from({ length: DAYS_PER_WEEK }, (_, i) => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const daysBack = mode === 'lastWeek'
      ? ((day.getDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK) + DAYS_PER_WEEK - i
      : DAYS_PER_WEEK - 1 - i;
    day.setDate(day.getDate() - daysBack);
    return { label: weekday(day), hours, cells: cellsOf((d) => d.toDateString() === day.toDateString()) };
  });
}

/** Hour of day, local clock, for chart and grid labels. */
export const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
