import { describe, expect, it, vi } from 'vitest';
import { solarTimes } from './solarTimes';
import { skyBody, sunArc } from './sky';
import { zipCoordinates } from './zipCoordinates';

// Expected minutes: NOAA calculator main.js calcSunriseSetUTC, with its second-pass Julian date refinement.
// https://gml.noaa.gov/grad/solcalc/main.js. Fractional-year approximation tolerance: 5 minutes.
const cases = [
  ['2026-06-21', 'America/New_York', 40.7128, -74.006, 325.02, 1230.76],
  ['2026-12-21', 'America/Los_Angeles', 34.0522, -118.2437, 414.69, 1007.74],
  ['2026-03-08', 'America/New_York', 40.7128, -74.006, 438.87, 1135.21],
  ['2026-11-01', 'America/New_York', 40.7128, -74.006, 386.39, 1012.19],
] as const;

describe('solar times', () => {
  it.each(cases)('matches NOAA on %s in %s', (day, zone, latitude, longitude, rise, set) => {
    try {
      vi.stubEnv('TZ', zone);
      const times = solarTimes(new Date(`${day}T12:00:00`), { latitude, longitude });
      expect(Math.abs(times.sunrise * 60 - rise)).toBeLessThan(5);
      expect(Math.abs(times.sunset * 60 - set)).toBeLessThan(5);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['America/New_York', '2026-03-08', '96910', 16 * 60 + 33, null],
    ['Europe/London', '2026-03-28', '96813', null, 4 * 60 + 45],
  ] as const)('uses the requested local date and event offset in %s', async (zone, day, zip, rise, set) => {
    try {
      vi.stubEnv('TZ', zone);
      const times = solarTimes(new Date(`${day}T12:00:00`), (await zipCoordinates(zip))!);
      if (rise !== null) expect(Math.abs(times.sunrise * 60 - rise)).toBeLessThan(5);
      if (set !== null) expect(Math.abs(times.sunset * 60 - set)).toBeLessThan(5);
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps polar day/night finite', () => {
    for (const month of [5, 11]) {
      const times = solarTimes(new Date(2026, month, 21), { latitude: 90, longitude: 0 });
      expect(Number.isFinite(skyBody(12, times).height)).toBe(true);
      expect(sunArc(48, times).every((p) => Number.isFinite(p.height))).toBe(true);
      expect(skyBody(12, times).body).toBe(month === 5 ? 'sun' : 'moon');
    }
  });

  it('moves the bodies and arc with the supplied daylight interval', () => {
    const times = { sunrise: 8, sunset: 16 };
    expect(skyBody(7, times).body).toBe('moon');
    expect(skyBody(12, times).height).toBeCloseTo(1);
    expect(sunArc(2, times).map((p) => p.x)).toEqual([8 / 24, 12 / 24, 16 / 24]);
  });
});

describe('bundled Census ZCTAs', () => {
  it('looks up leading-zero and western ZIPs, rejecting unknown and malformed input', async () => {
    expect(await zipCoordinates('00601')).toEqual({ latitude: 18.1806, longitude: -66.75 });
    expect((await zipCoordinates('90210'))?.latitude).toBeGreaterThan(34);
    expect(await zipCoordinates('00000')).toBeNull();
    expect(await zipCoordinates('9021')).toBeNull();
    expect(await zipCoordinates('')).toBeNull();
  });
});
