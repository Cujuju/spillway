/** The system clock's hour cycle: 24-hour, 12-hour, or null for the language's own default. */
export type HourCycle = 'h23' | 'h12' | null;
/** Main passes the hour cycle to renderers as this command-line argument. */
export const HOUR_CYCLE_ARG = '--spillway-hour-cycle=';
/** Matches `Date.prototype.toLocaleTimeString(locale)` with default options across 12h and 24h locales. */
export const DEFAULT_TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', second: 'numeric' };
/** Caps cached Intl formatter instances while easily holding the app's finite option sets. */
const MAX_FORMATTER_CACHE = 64;

const DATE_TIME_OPTION_KEYS: readonly (keyof Intl.DateTimeFormatOptions)[] = [
  'calendar', 'dateStyle', 'day', 'dayPeriod', 'era', 'formatMatcher', 'fractionalSecondDigits',
  'hour', 'hour12', 'hourCycle', 'localeMatcher', 'minute', 'month', 'numberingSystem',
  'second', 'timeStyle', 'timeZone', 'timeZoneName', 'weekday', 'year',
];
const NUMBER_OPTION_KEYS: readonly (keyof Intl.NumberFormatOptions)[] = [
  'compactDisplay', 'currency', 'currencyDisplay', 'currencySign', 'localeMatcher',
  'maximumFractionDigits', 'maximumSignificantDigits', 'minimumFractionDigits',
  'minimumIntegerDigits', 'minimumSignificantDigits', 'notation', 'numberingSystem',
  'roundingIncrement', 'roundingMode', 'roundingPriority', 'signDisplay', 'style',
  'trailingZeroDisplay', 'unit', 'unitDisplay', 'useGrouping',
];

let hourCycle: HourCycle = null;
let baseLocale: string | undefined;
let locale: string | undefined;
let cachedTimeZone: string | undefined;
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

export function setHourCycle(cycle: HourCycle): void {
  hourCycle = cycle;
  locale = undefined;
  dateTimeFormats.clear();
  numberFormats.clear();
}

export const parseHourCycle = (value: unknown): HourCycle => value === 'h23' || value === 'h12' ? value : null;
/** Locale for every date, time and number format: Chromium ignores the OS clock setting, so its hour cycle rides on the tag. */
export function appLocale(): string {
  if (locale !== undefined) return locale;
  baseLocale ??= new Intl.DateTimeFormat().resolvedOptions().locale;
  locale = hourCycle ? `${baseLocale}-u-hc-${hourCycle}` : baseLocale;
  return locale;
}

/** Reads each supported option once so getters cannot diverge between cache lookup and Intl construction. */
function normalizeOptions<T extends object>(options: T | undefined, keys: readonly (keyof T)[]): { key: string; snapshot: T | undefined } {
  if (!options) return { key: '[]', snapshot: undefined };
  const snapshot: Record<string, unknown> = {};
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined) {
      const name = String(key);
      snapshot[name] = value;
      entries.push([name, typeof value === 'number' && !Number.isFinite(value) ? String(value) : value]);
    }
  }
  return { key: JSON.stringify(entries), snapshot: snapshot as T };
}

function putCached<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_FORMATTER_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

/** Invalidates cached date formatters when the effective IANA time zone changes. */
function invalidateIfTimeZoneChanged(): void {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (cachedTimeZone === undefined) {
    cachedTimeZone = timeZone;
    return;
  }
  if (timeZone !== cachedTimeZone) {
    cachedTimeZone = timeZone;
    dateTimeFormats.clear();
  }
}

export function dateTimeFormat(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const { key, snapshot } = normalizeOptions(options, DATE_TIME_OPTION_KEYS);
  if (snapshot?.timeZone === undefined) invalidateIfTimeZoneChanged();
  let formatter = dateTimeFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(appLocale(), snapshot);
    putCached(dateTimeFormats, key, formatter);
  }
  return formatter;
}

export function numberFormat(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const { key, snapshot } = normalizeOptions(options, NUMBER_OPTION_KEYS);
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(appLocale(), snapshot);
    putCached(numberFormats, key, formatter);
  }
  return formatter;
}

/** Preserve the display text for invalid dates, which Intl formatters reject. */
export function formatDate(formatter: Intl.DateTimeFormat, date: Date): string {
  return Number.isNaN(date.getTime()) ? date.toString() : formatter.format(date);
}
