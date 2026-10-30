import type { Coordinates } from './zipCoordinates';

export interface SunTimes { sunrise: number; sunset: number }
export const FALLBACK_SUN_TIMES: SunTimes = { sunrise: 6, sunset: 18 };
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const DEGREES = Math.PI / 180;
/** Apparent solar disk, including atmospheric refraction (NOAA). */
const SUNRISE_ZENITH = 90.833 * DEGREES;

/** NOAA fractional-year equations: https://gml.noaa.gov/grad/solcalc/solareqns.PDF */
export function solarTimes(date: Date, { latitude, longitude }: Coordinates): SunTimes {
  const year = date.getFullYear();
  const midnight = Date.UTC(year, date.getMonth(), date.getDate());
  const day = (midnight - Date.UTC(year, 0, 1)) / DAY_MS;
  const yearDays = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS;
  const gamma = 2 * Math.PI * day / yearDays;
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const lat = latitude * DEGREES;
  const cosine = Math.cos(SUNRISE_ZENITH) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
  // Full daylight or darkness: finite intervals also keep the sky's divisions safe.
  if (cosine <= -1) return { sunrise: 0, sunset: 24 };
  if (cosine >= 1) return { sunrise: 12, sunset: 12 };
  const hourAngle = Math.acos(cosine) / DEGREES;
  const noon = 720 - 4 * longitude - eqTime;
  const localHour = (minutes: number) => {
    const event = new Date(midnight + minutes * MINUTE_MS);
    return ((minutes - event.getTimezoneOffset()) / MINUTES_PER_HOUR + 24) % 24;
  };
  return { sunrise: localHour(noon - 4 * hourAngle), sunset: localHour(noon + 4 * hourAngle) };
}
