const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2d 7h", "3h 12m", "45m", "now" — the two largest units, like Theo's "back in 2d 7h". */
export function compactDuration(ms: number): string {
  if (ms <= MINUTE) return 'now';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** "in 2 days", "in 3 hours", "in 12 min" for reset captions. */
export function relativeFuture(iso: string | null, now: number): string {
  if (!iso) return 'No reset pending';
  const ms = Date.parse(iso) - now;
  if (ms <= MINUTE) return 'any moment';
  if (ms >= 2 * DAY) return `in ${Math.round(ms / DAY)} days`;
  if (ms >= 2 * HOUR) return `in ${Math.round(ms / HOUR)} hours`;
  if (ms >= HOUR) return 'in 1 hour';
  return `in ${Math.round(ms / MINUTE)} min`;
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

export function dayTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function pct(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}
