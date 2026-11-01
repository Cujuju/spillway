import type { Coordinates } from './zipCoordinates';

const DEGREES = Math.PI / 180;
const DAY_MS = 86_400_000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const DAYS_PER_CENTURY = 36_525;
const OBLIQUITY = 23.439 * DEGREES;
/** Mean lunar horizontal parallax; the moon seen from the surface sits this much lower near the horizon. */
const PARALLAX_DEGREES = 0.95;

/**
 * Astronomical Almanac low-precision lunar series, good to about 0.3 degrees: amplitude, phase, rate per century.
 * Longitude adds the mean motion below; latitude is the series alone.
 */
const LONGITUDE_TERMS = [[6.29, 135.0, 477198.87], [-1.27, 259.3, -413335.36], [0.66, 235.7, 890534.22],
  [0.21, 269.9, 954397.74], [-0.19, 357.5, 35999.05], [-0.11, 186.5, 966404.03]] as const;
const LATITUDE_TERMS = [[5.13, 93.3, 483202.03], [0.28, 228.2, 960400.87], [-0.28, 318.3, 6003.18], [-0.17, 217.6, -407332.2]] as const;
const MEAN_LONGITUDE = 218.32;
const MEAN_MOTION = 481267.881;
/** Greenwich mean sidereal time at J2000 and its daily advance, in degrees. */
const GMST_J2000 = 280.46061837;
const GMST_PER_DAY = 360.98564736629;

const series = (terms: readonly (readonly [number, number, number])[], centuries: number) =>
  terms.reduce((sum, [amplitude, phase, rate]) => sum + amplitude * Math.sin((phase + rate * centuries) * DEGREES), 0);

/** Moon altitude in degrees at an instant, seen from the surface; no refraction. */
export function moonAltitude(t: number, { latitude, longitude }: Coordinates): number {
  const days = (t - J2000_MS) / DAY_MS;
  const centuries = days / DAYS_PER_CENTURY;
  const lambda = (MEAN_LONGITUDE + MEAN_MOTION * centuries + series(LONGITUDE_TERMS, centuries)) * DEGREES;
  const beta = series(LATITUDE_TERMS, centuries) * DEGREES;
  const x = Math.cos(beta) * Math.cos(lambda);
  const y = Math.cos(OBLIQUITY) * Math.cos(beta) * Math.sin(lambda) - Math.sin(OBLIQUITY) * Math.sin(beta);
  const z = Math.sin(OBLIQUITY) * Math.cos(beta) * Math.sin(lambda) + Math.cos(OBLIQUITY) * Math.sin(beta);
  const hourAngle = (GMST_J2000 + GMST_PER_DAY * days + longitude) * DEGREES - Math.atan2(y, x);
  const lat = latitude * DEGREES;
  const declination = Math.asin(z);
  const geocentric = Math.asin(Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)) / DEGREES;
  return geocentric - PARALLAX_DEGREES * Math.cos(geocentric * DEGREES);
}
