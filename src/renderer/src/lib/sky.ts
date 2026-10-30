/** Fixed until real sunrise/sunset lands (issue #78). */
export const SUNRISE_HOUR = 6;
export const SUNSET_HOUR = 18;
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

const DAYLIGHT = SUNSET_HOUR - SUNRISE_HOUR;
const NIGHT = HOURS_PER_DAY - DAYLIGHT;

/** Where the sun or moon sits for a fractional local hour: x as a share of the day, height 0–1 above the horizon. */
export function skyBody(hour: number): { body: 'sun' | 'moon'; x: number; height: number } {
  const day = hour >= SUNRISE_HOUR && hour < SUNSET_HOUR;
  const t = day ? (hour - SUNRISE_HOUR) / DAYLIGHT : ((hour - SUNSET_HOUR + HOURS_PER_DAY) % HOURS_PER_DAY) / NIGHT;
  return { body: day ? 'sun' : 'moon', x: hour / HOURS_PER_DAY, height: Math.sin(Math.PI * t) };
}

/** Points along the sun's arc, as x share of the day and height 0–1, for drawing. */
export function sunArc(steps: number): { x: number; height: number }[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return { x: (SUNRISE_HOUR + t * DAYLIGHT) / HOURS_PER_DAY, height: Math.sin(Math.PI * t) };
  });
}
