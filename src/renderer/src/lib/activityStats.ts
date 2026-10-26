import { addCounts, emptyCounts } from '@shared/activityCounts';
import { promptTokens } from '@shared/modelPrices';
import type { ActivityBucket, ActivityCounts } from '@shared/types';

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

export type Range = '24h' | '7d' | '30d';
export type Metric = 'cost' | 'tokens' | 'requests';

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

/** Bucket starts for a range ending at `now`, oldest first; local-clock steps survive DST changes. */
export function bucketStarts(range: Range, now: number): number[] {
  const { buckets, hoursPerBucket } = RANGES[range];
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

export const inRange = (rows: ActivityBucket[], starts: number[]) => rows.filter((r) => r.start >= starts[0]!);

export interface ModelRow {
  provider: string;
  model: string;
  summary: Summary;
}

/** Per provider and model, costliest first, then by tokens. */
export function byModel(rows: ActivityBucket[]): ModelRow[] {
  const groups = new Map<string, ActivityBucket[]>();
  for (const r of rows) {
    const key = `${r.provider}|${r.model}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()]
    .map((g) => ({ provider: g[0]!.provider, model: g[0]!.model, summary: summarize(g) }))
    .sort((a, b) => b.summary.costUsd - a.summary.costUsd || b.summary.totalTokens - a.summary.totalTokens);
}

export type HeatMode = 'week' | 'rhythm';

export interface HeatRow {
  label: string;
  /** One per local hour, 0-23. */
  cells: Summary[];
}

/** Monday-first weekday order for the rhythm view. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const weekday = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short' });

/**
 * Day-by-hour grid. "week": the last 7 local days, oldest first. "rhythm": every hour of `rows`
 * summed by weekday. Daily totals of expired days have no hour, so they are left out.
 */
export function heatGrid(rows: ActivityBucket[], mode: HeatMode, now: number): HeatRow[] {
  const hourly = rows.filter((r) => !r.wholeDay);
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
      return { label: weekday(sample), cells: cellsOf((d) => d.getDay() === wd) };
    });
  }
  return Array.from({ length: DAYS_PER_WEEK }, (_, i) => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - (DAYS_PER_WEEK - 1 - i));
    return { label: weekday(day), cells: cellsOf((d) => d.toDateString() === day.toDateString()) };
  });
}

/** Hour of day, local clock, for chart and grid labels. */
export const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
