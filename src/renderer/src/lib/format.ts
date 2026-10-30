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

export function dayTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** "Sat, Oct 25" for a local YYYY-MM-DD day key. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function dateTime(at: string | number): string {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function pct(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}

/** Dashboard quota figures: 3 significant digits, truncated so a sliver never reads 0 and a near-full window never reads 100. */
const QUOTA_SIGNIFICANT_DIGITS = 3;
const quotaFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: QUOTA_SIGNIFICANT_DIGITS, roundingMode: 'trunc' });
/** Doubles hold ~15.9 digits; arithmetic noise sits in the last few, so 12 drops it (56.99999999999999 → 57) before truncating. */
const FLOAT_NOISE_FREE_DIGITS = 12;
export function quotaPercent(value: number | null): string {
  return value === null ? '—' : `${quotaFormat.format(Number(value.toPrecision(FLOAT_NOISE_FREE_DIGITS)))}%`;
}

/** Below a cent, "<$0.01"; to the cent under $1,000; whole dollars above. */
const WHOLE_DOLLARS_FROM = 1000;
const CENT = 0.01;
export function usd(v: number): string {
  if (v > 0 && v < CENT) return '<$0.01';
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: v >= WHOLE_DOLLARS_FROM ? 0 : 2, minimumFractionDigits: v >= WHOLE_DOLLARS_FROM ? 0 : 2 });
}

/** "1.2M", "34K", "980" for token counts. */
export function compactNumber(v: number): string {
  return v.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}
