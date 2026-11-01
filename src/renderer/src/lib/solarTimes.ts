import { createMemo, createResource, type Accessor } from 'solid-js';
import { zipCoordinates, type Coordinates } from './zipCoordinates';

export interface SunTimes { sunrise: number; sunset: number }
export const FALLBACK_SUN_TIMES: SunTimes = { sunrise: 6, sunset: 18 };
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
/** Earth turns one degree every four minutes. */
const MINUTES_PER_DEGREE = 4;
const HALF_TURN_DEGREES = 180;
// Longitude and the local timezone can place events two UTC dates away.
const NEIGHBOUR_DAYS = 2;
const DEGREES = Math.PI / 180;
/** Apparent solar disk, including atmospheric refraction (NOAA). */
const SUNRISE_ZENITH = 90.833 * DEGREES;

type SolarEvents = { kind: 'events'; sunrise: number; sunset: number } | { kind: 'polar-day' | 'polar-night' };

/** NOAA fractional-year terms at an instant: equation of time (minutes) and declination (radians). https://gml.noaa.gov/grad/solcalc/solareqns.PDF */
function sunTerms(t: number): { eqTime: number; decl: number } {
  const year = new Date(t).getUTCFullYear();
  const yearDays = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS;
  const gamma = 2 * Math.PI * ((t - Date.UTC(year, 0, 1)) / DAY_MS) / yearDays;
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  return { eqTime, decl };
}

function utcEvents(midnight: number, { latitude, longitude }: Coordinates): SolarEvents {
  const { eqTime, decl } = sunTerms(midnight);
  const lat = latitude * DEGREES;
  const cosine = Math.cos(SUNRISE_ZENITH) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
  if (cosine <= -1) return { kind: 'polar-day' };
  if (cosine >= 1) return { kind: 'polar-night' };
  const hourAngle = Math.acos(cosine) / DEGREES;
  const noon = 720 - MINUTES_PER_DEGREE * longitude - eqTime;
  return { kind: 'events', sunrise: midnight + (noon - MINUTES_PER_DEGREE * hourAngle) * MINUTE_MS,
    sunset: midnight + (noon + MINUTES_PER_DEGREE * hourAngle) * MINUTE_MS };
}

/** Select each event by its local calendar date, including its own DST offset. */
export function solarTimes(date: Date, coordinates: Coordinates): SunTimes {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const from = new Date(year, month, day).getTime();
  const to = new Date(year, month, day + 1).getTime();
  const midnight = Date.UTC(year, month, day);
  const selected: Partial<SunTimes> = {};
  for (let offset = -NEIGHBOUR_DAYS; offset <= NEIGHBOUR_DAYS; offset++) {
    const events = utcEvents(midnight + offset * DAY_MS, coordinates);
    if (events.kind !== 'events') continue;
    for (const key of ['sunrise', 'sunset'] as const) {
      const instant = events[key];
      if (instant >= from && instant < to) {
        const event = new Date(instant);
        const utcMidnight = Date.UTC(event.getUTCFullYear(), event.getUTCMonth(), event.getUTCDate());
        selected[key] = ((instant - utcMidnight) / MINUTE_MS - event.getTimezoneOffset()) / MINUTES_PER_HOUR;
        selected[key] = (selected[key]! + 24) % 24;
      }
    }
  }
  if (selected.sunrise === undefined && selected.sunset === undefined) {
    return utcEvents(midnight, coordinates).kind === 'polar-day' ? { sunrise: 0, sunset: 24 } : { sunrise: 12, sunset: 12 };
  }
  return { sunrise: selected.sunrise ?? 0, sunset: selected.sunset ?? 24 };
}

/** Sun altitude in degrees at an instant, from the NOAA hour angle; no refraction. */
export function sunAltitude(t: number, { latitude, longitude }: Coordinates): number {
  const { eqTime, decl } = sunTerms(t);
  const utcMinutes = (((t % DAY_MS) + DAY_MS) % DAY_MS) / MINUTE_MS;
  const hourAngle = ((utcMinutes + eqTime + MINUTES_PER_DEGREE * longitude) / MINUTES_PER_DEGREE - HALF_TURN_DEGREES) * DEGREES;
  const lat = latitude * DEGREES;
  return Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)) / DEGREES;
}

/** Without a ZIP: the equator on the local clock's meridian, so days run about 6 to 18. */
export const fallbackCoordinates = (t: number): Coordinates =>
  ({ latitude: 0, longitude: -new Date(t).getTimezoneOffset() / MINUTES_PER_DEGREE });

/** Coordinates for a ZIP; null while loading, or for a blank or unknown ZIP. */
export function createZipCoordinates(zip: () => string): Accessor<Coordinates | null> {
  const [coordinates] = createResource(() => zip() || null, (z) => zipCoordinates(z).catch(() => null));
  // A blank ZIP stops the resource but keeps its last value, so the ZIP is checked again here.
  return createMemo(() => (zip() ? coordinates() ?? null : null));
}

/** Sun times on `now`'s local date for a ZIP; null while loading, or for a blank or unknown ZIP. */
export function createZipSunTimes(zip: () => string, now: () => number): Accessor<SunTimes | null> {
  const coordinates = createZipCoordinates(zip);
  return createMemo(() => {
    const point = coordinates();
    return point ? solarTimes(new Date(now()), point) : null;
  });
}
