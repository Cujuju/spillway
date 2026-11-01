import { FALLBACK_SUN_TIMES, type SunTimes } from './solarTimes';

/** Horizon as a share of the sky's height, from the top. */
export const HORIZON_Y = 0.62;
/** Hours the sky takes to pass between night and day colours at each end of daylight. */
export const TWILIGHT_HOURS = 1.5;
const HOURS_PER_DAY = 24;
/** Earth's axial tilt: the sun's highest altitude anywhere in the year is 90 minus latitude beyond it. */
const AXIAL_TILT = 23.44;
const ZENITH = 90;

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

/** Highest altitude the sun reaches at this latitude over a year; the sky's full height. */
export const peakAltitude = (latitude: number) => ZENITH - Math.max(0, Math.abs(latitude) - AXIAL_TILT);

function daylightSpan(times: SunTimes) {
  const polarDay = times.sunset - times.sunrise === HOURS_PER_DAY;
  const polarNight = times.sunrise === times.sunset;
  const daylight = polarDay ? HOURS_PER_DAY : polarNight ? 0 : (times.sunset - times.sunrise + HOURS_PER_DAY) % HOURS_PER_DAY;
  const twilight = Math.min(TWILIGHT_HOURS, daylight / 2, (HOURS_PER_DAY - daylight) / 2);
  return { polarDay, polarNight, daylight, twilight };
}

/** 0 at night, 1 in daylight, eased across twilight (half at sunrise and sunset). */
export function dayWeight(hour: number, times: SunTimes = FALLBACK_SUN_TIMES): number {
  const { polarDay, polarNight, daylight, twilight } = daylightSpan(times);
  if (polarDay || polarNight) return polarDay ? 1 : 0;
  const sinceRise = (hour - times.sunrise + HOURS_PER_DAY) % HOURS_PER_DAY;
  const inside = sinceRise <= daylight ? Math.min(sinceRise, daylight - sinceRise) : -Math.min(sinceRise - daylight, HOURS_PER_DAY - sinceRise);
  const t = Math.min(1, Math.max(0, (inside + twilight) / (2 * twilight)));
  return t * t * (3 - 2 * t);
}

const STAR_COUNT = 22;
/** R2 low-discrepancy steps scatter stars without rows. */
const R2_X = 0.7548776662;
const R2_Y = 0.569840291;
const R2_OFFSET = 0.5;
const STAR_BAND = 0.9;
const STAR_SIZES = 3;
const TWINKLE_EVERY = 4;
/** Stars brighten over this many hours after dusk and dim as long before dawn. */
const STAR_FADE_HOURS = 1.5;
/** Twinkle delays step by this much, wrapped to the CSS twinkle period. */
const TWINKLE_STAGGER_S = 0.37;
const TWINKLE_PERIOD_S = 2.8;

const pct = (hour: number) => `${hour / HOURS_PER_DAY * 100}%`;

/** One 24-hour gradient cycle, its daylight mask, and the strictly dark interval share the same twilight bounds. */
export function skyGeometry(times: SunTimes = FALLBACK_SUN_TIMES) {
  const { polarDay, polarNight, daylight, twilight } = daylightSpan(times);
  const rise = times.sunrise;
  const set = rise + daylight;
  const stops = [rise - twilight, rise, rise + twilight, set - twilight, set, set + twilight, rise - twilight + HOURS_PER_DAY];
  const colours = ['night', 'glow', 'day', 'day', 'glow', 'night', 'night'];
  const gradient = polarDay ? 'var(--sky-day)' : polarNight ? 'var(--sky-night)'
    : `repeating-linear-gradient(90deg, ${stops.map((hour, i) => `var(--sky-${colours[i]}) ${pct(hour)}`).join(', ')})`;
  const daylightMask = polarDay ? 'linear-gradient(#000, #000)' : polarNight ? 'linear-gradient(transparent, transparent)'
    : `repeating-linear-gradient(90deg, transparent ${pct(stops[0]!)}, #000 ${pct(stops[2]!)}, #000 ${pct(stops[3]!)}, transparent ${pct(stops[5]!)}, transparent ${pct(stops[6]!)})`;
  const dusk = polarNight ? 0 : (set + twilight) % HOURS_PER_DAY;
  const nightHours = polarNight ? HOURS_PER_DAY : Math.max(0, HOURS_PER_DAY - daylight - 2 * twilight);
  const stars = nightHours === 0 ? [] : Array.from({ length: STAR_COUNT }, (_, i) => {
    const sinceDusk = ((R2_OFFSET + i * R2_X) % 1) * nightHours;
    const edge = polarNight ? HOURS_PER_DAY : Math.min(sinceDusk, nightHours - sinceDusk);
    return { x: ((dusk + sinceDusk) % HOURS_PER_DAY) / HOURS_PER_DAY, y: ((R2_OFFSET + i * R2_Y) % 1) * HORIZON_Y * STAR_BAND,
      size: i % STAR_SIZES, fade: Math.min(1, edge / STAR_FADE_HOURS),
      twinkle: i % TWINKLE_EVERY === 0, delay: (i * TWINKLE_STAGGER_S) % TWINKLE_PERIOD_S };
  });
  return { twilight, stops, gradient, daylightMask, nightHours, stars };
}
