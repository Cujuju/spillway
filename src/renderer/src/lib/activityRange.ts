import { localHourStart } from '@shared/activityCounts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOURS_SHOWN_BY_24H = 24;
const DAYS_PER_WEEK = 7;
/** Local clock hours per bar for the 3-hour unit. */
const THREE_HOURS = 3;

export const RANGES = ['24h', '7d', '30d', '90d', '1y', 'all', 'custom'] as const;
export type Range = (typeof RANGES)[number];
/** Calendar days each day-based preset covers, today included. */
const PRESET_DAYS: Partial<Record<Range, number>> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

/** Inclusive local days, YYYY-MM-DD. */
export interface CustomRange { from: string; to: string }
export const isCustomRange = (v: unknown): v is CustomRange =>
  !!v && typeof v === 'object' && typeof (v as CustomRange).from === 'string' && typeof (v as CustomRange).to === 'string';

/** Epoch ms; `to` is now or the end of the last chosen day, whichever is earlier. */
export interface Span { from: number; to: number }

export type BucketUnit = 'hour' | '3h' | 'day' | 'week' | 'month';
/** Smallest unit whose span limit fits, keeping roughly 24–120 bars: 24h hourly, 7d 3-hourly, 90d daily, 1y weekly. */
const UNIT_LIMITS: { maxDays: number; unit: BucketUnit }[] = [
  { maxDays: 2, unit: 'hour' }, { maxDays: 14, unit: '3h' }, { maxDays: 120, unit: 'day' }, { maxDays: 730, unit: 'week' },
];

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const shiftDays = (t: number, days: number) => { const d = new Date(t); d.setDate(d.getDate() + days); return d.getTime(); };
const parseDay = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!).getTime(); };
export const dayText = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** `earliest`: the oldest activity held, for "All". */
export function rangeSpan(range: Range, now: number, custom: CustomRange, earliest: number | null): Span {
  if (range === '24h') return { from: localHourStart(now) - (HOURS_SHOWN_BY_24H - 1) * HOUR_MS, to: now };
  if (range === 'all') return { from: startOfDay(earliest ?? now), to: now };
  if (range === 'custom') {
    const [a, b] = [parseDay(custom.from), parseDay(custom.to)].sort((x, y) => x - y);
    return { from: Math.min(a!, startOfDay(now)), to: Math.min(now, shiftDays(b!, 1) - 1) };
  }
  return { from: shiftDays(startOfDay(now), 1 - PRESET_DAYS[range]!), to: now };
}

export const spanDays = (s: Span) => (s.to - s.from) / DAY_MS;

export const bucketUnit = (s: Span): BucketUnit => UNIT_LIMITS.find((l) => spanDays(s) <= l.maxDays)?.unit ?? 'month';

/** Start of the local bucket holding `t`. */
export function floorTo(t: number, unit: BucketUnit): number {
  if (unit === 'hour') return localHourStart(t);
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  if (unit === '3h') d.setHours(d.getHours() - (d.getHours() % THREE_HOURS));
  else d.setHours(0);
  // Weeks start on Monday.
  if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK));
  if (unit === 'month') d.setDate(1);
  return d.getTime();
}

function next(t: number, unit: BucketUnit): number {
  if (unit === 'hour') return t + HOUR_MS;
  const d = new Date(t);
  if (unit === '3h') d.setHours(d.getHours() + THREE_HOURS);
  else if (unit === 'day') d.setDate(d.getDate() + 1);
  else if (unit === 'week') d.setDate(d.getDate() + DAYS_PER_WEEK);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

/** Oldest first, local calendar boundaries; the last bucket holds `span.to`. */
export function bucketStarts(span: Span, unit: BucketUnit): number[] {
  const starts: number[] = [];
  for (let t = floorTo(span.from, unit); t <= span.to; t = next(t, unit)) starts.push(t);
  return starts;
}

/** Local days to fetch so the span is covered; null fetches all. */
export const daysToFetch = (range: Range, span: Span, now: number): number | null =>
  range === 'all' ? null : Math.round((startOfDay(now) - startOfDay(span.from)) / DAY_MS) + 1;

export const UNIT_NOTE: Record<BucketUnit, string> = { hour: 'Hourly', '3h': 'Every 3 hours', day: 'Daily', week: 'Weekly', month: 'Monthly' };

export function axisLabel(t: number, unit: BucketUnit): string {
  if (unit === 'hour') return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' });
  if (unit === 'month') return new Date(t).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return new Date(t).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

/** "Mon 3 AM", "Mon 3 AM – 6 AM", "Mon, Oct 26", "Week of Oct 26", "October 2026". */
export function bucketTitle(start: number, end: number, unit: BucketUnit): string {
  const d = new Date(start);
  if (unit === 'hour') return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
  if (unit === '3h') return `${d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })} – ${new Date(end).toLocaleTimeString(undefined, { hour: 'numeric' })}`;
  if (unit === 'day') return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (unit === 'week') return `Week of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
