import { dayLabel } from './format';
import { appLocale } from '@shared/timeFormat';

/** Daily totals roll up into weeks, months or years; keys sort newest first as strings. */
export const TOTALS_PERIODS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
] as const;
export type TotalsPeriod = (typeof TOTALS_PERIODS)[number]['value'];

const DAYS_PER_WEEK = 7;
/** Weeks start on Monday (ISO 8601). */
const MONDAY = 1;

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

/** The bucket a local YYYY-MM-DD day falls in: its week's Monday, YYYY-MM, or YYYY. */
export function periodKey(day: string, period: TotalsPeriod): string {
  if (period === 'day') return day;
  if (period === 'month') return day.slice(0, 7);
  if (period === 'year') return day.slice(0, 4);
  const date = parseDay(day);
  date.setDate(date.getDate() - ((date.getDay() - MONDAY + DAYS_PER_WEEK) % DAYS_PER_WEEK));
  return localDay(date);
}

/** "Sat, Oct 25", "Week of Oct 20", "October 2026", "2026". */
export function periodLabel(key: string, period: TotalsPeriod): string {
  if (period === 'year') return key;
  if (period === 'month') return parseDay(`${key}-01`).toLocaleDateString(appLocale(), { month: 'long', year: 'numeric' });
  if (period === 'week') return `Week of ${parseDay(key).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' })}`;
  return dayLabel(key);
}
