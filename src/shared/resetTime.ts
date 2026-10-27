const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A weekday names one date only within the coming week; further out needs month and day. */
const WEEKDAY_SPAN_DAYS = 7;

/** "2d 7h 12m", "3h 12m", "12m": every unit down to minutes, larger zero units dropped. */
export function untilText(ms: number): string {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Local calendar days from `now` to `at`; rounded so a DST shift doesn't skew it. */
function daysAhead(at: number, now: number): number {
  const startOf = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  return Math.round((startOf(at) - startOf(now)) / DAY);
}

/** "2:30 PM" today, "Mon 2:30 PM" within the week, "Nov 2, 2:30 PM" beyond. */
export function clockText(at: number, now: number): string {
  const days = daysAhead(at, now);
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (days === 0) return new Date(at).toLocaleTimeString(undefined, time);
  if (days > 0 && days < WEEKDAY_SPAN_DAYS) return new Date(at).toLocaleString(undefined, { weekday: 'short', ...time });
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', ...time });
}

/** "in 3h 12m · Mon 2:30 PM": time left and the local reset time. */
export function resetText(at: string | number, now: number): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  const left = t - now;
  return `${left <= MINUTE ? 'any moment' : `in ${untilText(left)}`} · ${clockText(t, now)}`;
}
