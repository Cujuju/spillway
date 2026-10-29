/** Wheel zoom for time charts: pure range math, so the chart only wires events. */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Narrowest view: an hour still holds a dozen 5-minute history samples. */
export const MIN_ZOOM_SPAN_MS = HOUR_MS;
/** Chromium reports one mouse-wheel notch as this many pixels of deltaY. */
const WHEEL_NOTCH_PX = 100;
/** Each notch widens or narrows the span by this factor. */
const ZOOM_PER_NOTCH = 1.25;

export interface TimeRange {
  from: number;
  to: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Span factor for a wheel delta: wheel up (negative deltaY) widens, wheel down narrows. Trackpads scale smoothly. */
export const wheelFactor = (deltaY: number) => ZOOM_PER_NOTCH ** (-deltaY / WHEEL_NOTCH_PX);

/**
 * `view` scaled by `factor` around `anchor`, which keeps its place on screen.
 * The result stays inside `bounds` and no narrower than MIN_ZOOM_SPAN_MS (unless `bounds` is).
 */
export function zoomRange(view: TimeRange, anchor: number, factor: number, bounds: TimeRange): TimeRange {
  const oldSpan = view.to - view.from;
  const limit = bounds.to - bounds.from;
  const span = clamp(oldSpan * factor, Math.min(MIN_ZOOM_SPAN_MS, limit), limit);
  const at = clamp(anchor, view.from, view.to);
  const from = clamp(at - (at - view.from) * (span / oldSpan), bounds.from, bounds.to - span);
  return { from, to: from + span };
}

/** `view` moved later by `shift` ms (earlier if negative), stopping at the edges of `bounds`. */
export function panRange(view: TimeRange, shift: number, bounds: TimeRange): TimeRange {
  const span = view.to - view.from;
  const from = clamp(view.from + shift, bounds.from, bounds.to - span);
  return { from, to: from + span };
}

/** Tick spacings, finest first; a chart takes the finest that fits MAX_X_TICKS. */
const TICK_STEPS_MS = [15 * MINUTE_MS, 30 * MINUTE_MS, HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS];
/** Most x labels a chart shows; short time labels stay apart at the narrowest window. */
const MAX_X_TICKS = 12;
/** Daily labels name the weekday up to a week; wider spans name the date so days don't repeat. */
const WEEKDAY_LABEL_MAX_MS = 7 * DAY_MS;

/** X-axis ticks on local clock boundaries for `range`. */
export function timeTicks(range: TimeRange): { t: number; label: string }[] {
  const span = range.to - range.from;
  const step = TICK_STEPS_MS.find((s) => span / s <= MAX_X_TICKS) ?? TICK_STEPS_MS.at(-1)!;
  const daily = step >= DAY_MS;
  const start = new Date(range.from);
  if (daily) start.setHours(24, 0, 0, 0);
  else {
    const stepMin = step / MINUTE_MS;
    start.setHours(0, Math.ceil((start.getHours() * 60 + start.getMinutes()) / stepMin) * stepMin, 0, 0);
  }
  const label = (d: Date) =>
    daily
      ? d.toLocaleDateString(undefined, span <= WEEKDAY_LABEL_MAX_MS ? { weekday: 'short' } : { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString(undefined, step < HOUR_MS ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
  const out: { t: number; label: string }[] = [];
  for (let t = start.getTime(); t <= range.to; t += step) {
    if (t >= range.from) out.push({ t, label: label(new Date(t)) });
  }
  return out;
}
