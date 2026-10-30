import { FALLBACK_SUN_TIMES, type SunTimes } from './solarTimes';

/** Default clock hours when no location is configured. */
export const SUNRISE_HOUR = FALLBACK_SUN_TIMES.sunrise;
export const SUNSET_HOUR = FALLBACK_SUN_TIMES.sunset;
/** Hours the sky takes to pass between night and day colours at each end of daylight. */
export const TWILIGHT_HOURS = 1.5;
const HOURS_PER_DAY = 24;

/** Reference new moon (UTC) and the mean synodic month in days. */
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_DAYS = 29.530588853;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. Mean phase, good to within about a day. */
export function moonPhase(t: number): number {
  const age = (t - NEW_MOON_MS) / DAY_MS / SYNODIC_DAYS;
  return age - Math.floor(age);
}

const PHASE_NAMES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
export const phaseName = (phase: number) => PHASE_NAMES[Math.round(phase * PHASE_NAMES.length) % PHASE_NAMES.length]!;

/**
 * SVG path of the lit part of a moon of radius r centred on 0,0. Waxing lights the right limb.
 * The terminator is a half-ellipse whose width follows the phase.
 */
export function moonPath(phase: number, r: number): string {
  const waxing = phase < 0.5;
  const rx = Math.abs(Math.cos(2 * Math.PI * phase)) * r;
  const crescent = phase < 0.25 || phase > 0.75;
  // Top to bottom along the lit limb, then back up along the terminator.
  const limbSweep = waxing ? 1 : 0;
  const terminatorSweep = waxing === crescent ? 0 : 1;
  return `M 0 ${-r} A ${r} ${r} 0 0 ${limbSweep} 0 ${r} A ${rx} ${r} 0 0 ${terminatorSweep} 0 ${-r} Z`;
}

/** Where the sun or moon sits at a fractional local hour, with height above the horizon. */
export function skyBody(hour: number, times: SunTimes = FALLBACK_SUN_TIMES): { body: 'sun' | 'moon'; x: number; height: number } {
  const daylight = (times.sunset - times.sunrise + HOURS_PER_DAY) % HOURS_PER_DAY;
  const allDay = times.sunset - times.sunrise === HOURS_PER_DAY;
  const sinceRise = (hour - times.sunrise + HOURS_PER_DAY) % HOURS_PER_DAY;
  const day = allDay || sinceRise < daylight;
  const t = day ? sinceRise / (allDay ? HOURS_PER_DAY : daylight)
    : ((hour - times.sunset + HOURS_PER_DAY) % HOURS_PER_DAY) / (HOURS_PER_DAY - daylight);
  return { body: day ? 'sun' : 'moon', x: hour / HOURS_PER_DAY, height: Math.sin(Math.PI * t) };
}

/** Points along the sun's arc, as x share of the day and height above the horizon. */
export function sunArc(steps: number, times: SunTimes = FALLBACK_SUN_TIMES): { x: number; height: number }[] {
  if (times.sunrise === times.sunset) return [];
  const daylight = (times.sunset - times.sunrise + HOURS_PER_DAY) % HOURS_PER_DAY || HOURS_PER_DAY;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return { x: (times.sunrise + t * daylight) / HOURS_PER_DAY, height: Math.sin(Math.PI * t) };
  });
}

const STAR_COUNT = 22;
/** R2 low-discrepancy steps scatter stars without rows. */
const R2_X = 0.7548776662;
const R2_Y = 0.569840291;
const R2_OFFSET = 0.5;
const STAR_HORIZON = 0.6;
const STAR_BAND = 0.9;
const DIM_EVERY = 3;

/** One 24-hour gradient cycle and the strictly dark interval share the same twilight bounds. */
export function skyGeometry(times: SunTimes = FALLBACK_SUN_TIMES) {
  const polarDay = times.sunset - times.sunrise === HOURS_PER_DAY;
  const polarNight = times.sunrise === times.sunset;
  const daylight = polarDay ? HOURS_PER_DAY : (times.sunset - times.sunrise + HOURS_PER_DAY) % HOURS_PER_DAY;
  const twilight = Math.min(TWILIGHT_HOURS, daylight / 2, (HOURS_PER_DAY - daylight) / 2);
  const rise = times.sunrise;
  const set = rise + daylight;
  const stops = [rise - twilight, rise, rise + twilight, set - twilight, set, set + twilight, rise - twilight + HOURS_PER_DAY];
  const colours = ['night', 'glow', 'day', 'day', 'glow', 'night', 'night'];
  const gradient = polarDay ? 'var(--sky-day)' : polarNight ? 'var(--sky-night)'
    : `repeating-linear-gradient(90deg, ${stops.map((hour, i) => `var(--sky-${colours[i]}) ${hour / HOURS_PER_DAY * 100}%`).join(', ')})`;
  const dawn = polarNight ? 0 : (rise - twilight + HOURS_PER_DAY) % HOURS_PER_DAY;
  const dusk = polarNight ? 0 : (set + twilight) % HOURS_PER_DAY;
  const nightHours = polarNight ? HOURS_PER_DAY : Math.max(0, HOURS_PER_DAY - daylight - 2 * twilight);
  const wrapped = dusk > dawn;
  const stars = nightHours === 0 ? [] : Array.from({ length: STAR_COUNT }, (_, i) => {
    const h = ((R2_OFFSET + i * R2_X) % 1) * nightHours;
    const hour = wrapped ? h < dawn ? h : h + dusk - dawn : dusk + h;
    return { x: hour / HOURS_PER_DAY, y: ((R2_OFFSET + i * R2_Y) % 1) * STAR_HORIZON * STAR_BAND, dim: i % DIM_EVERY === 0 };
  });
  return { twilight, stops, gradient, nightHours, stars };
}
