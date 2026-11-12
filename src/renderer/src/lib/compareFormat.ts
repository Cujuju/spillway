import type { DaySpan } from '@shared/activityCompare';
import { usd } from './format';

const PERCENT = 100;
/** From ten times the baseline, decimals stop adding meaning. */
const WHOLE_MULTIPLE_FROM = 10;
const MULTIPLE_DIGITS = 2;
const POINT_DIGITS = 1;

/** USD with a minus sign for negatives. */
export const money = (v: number, digits?: number): string => (v < 0 ? `−${usd(-v, digits)}` : usd(v, digits));
/** "2.45×", "12×". */
export const multiple = (r: number): string => `${r >= WHOLE_MULTIPLE_FROM ? r.toFixed(0) : r.toFixed(MULTIPLE_DIGITS)}×`;
/** "+1.4 pt", "−0.6 pt": a difference between two percentages. */
export const points = (d: number): string => `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(POINT_DIGITS)} pt`;
/** Percent share; null without a denominator. */
export const share = (part: number, whole: number): number | null => (whole > 0 ? (part / whole) * PERCENT : null);

/** "Oct 18 – Nov 11" for local day keys. */
export function spanText(span: Pick<DaySpan, 'from' | 'to'>): string {
  const label = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  return span.from === span.to ? label(span.from) : `${label(span.from)} – ${label(span.to)}`;
}

/** "9 of 25 days". */
export const daysOf = (part: DaySpan | null, range: DaySpan): string => `${part?.days ?? 0} of ${range.days} days`;

/** Where a coverage bar's filled part starts, as a percentage of the range. */
export const coverageStart = (part: DaySpan | null, range: DaySpan): number => (part ? ((range.days - part.days) / range.days) * PERCENT : PERCENT);
