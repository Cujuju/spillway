/** The system clock's hour cycle: 24-hour, 12-hour, or null for the language's own default. */
export type HourCycle = 'h23' | 'h12' | null;
/** Main passes the hour cycle to renderers as this command-line argument. */
export const HOUR_CYCLE_ARG = '--spillway-hour-cycle=';
let hourCycle: HourCycle = null;
export function setHourCycle(cycle: HourCycle): void { hourCycle = cycle; }
export const parseHourCycle = (value: unknown): HourCycle => value === 'h23' || value === 'h12' ? value : null;
/** Locale for every date, time and number format: Chromium ignores the OS clock setting, so its hour cycle rides on the tag. */
export function appLocale(): string {
  const base = new Intl.DateTimeFormat().resolvedOptions().locale;
  return hourCycle ? `${base}-u-hc-${hourCycle}` : base;
}
