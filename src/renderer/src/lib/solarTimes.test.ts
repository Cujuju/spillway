import { describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createZipSunTimes, fallbackCoordinates, solarTimes, sunAltitude } from './solarTimes';
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

  it.each(cases)('puts the sun on the horizon at NOAA sunrise and sunset on %s', (day, zone, latitude, longitude, rise, set) => {
    try {
      vi.stubEnv('TZ', zone);
      // Wall-clock minutes, so DST change days land on the right instant.
      const at = (minutes: number) => { const d = new Date(`${day}T00:00:00`); d.setMinutes(minutes); return d.getTime(); };
      for (const minutes of [rise, set]) {
        // NOAA sunrise is the refracted upper limb: the centre sits 0.833 degrees below the horizon.
        expect(sunAltitude(at(minutes), { latitude, longitude })).toBeCloseTo(-0.833, 0);
      }
      const noon = at((rise + set) / 2);
      expect(sunAltitude(noon, { latitude, longitude })).toBeGreaterThan(0);
      expect(sunAltitude(noon + 12 * 3_600_000, { latitude, longitude })).toBeLessThan(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it('falls back to the equator on the local meridian: a 12-hour day around noon', () => {
    try {
      vi.stubEnv('TZ', 'America/New_York');
      const day = new Date('2026-03-20T12:00:00');
      const times = solarTimes(day, fallbackCoordinates(day.getTime()));
      expect(times.sunset - times.sunrise).toBeCloseTo(12, 0);
      expect(Math.abs((times.sunrise + times.sunset) / 2 - 12)).toBeLessThan(0.5);
    } finally { vi.unstubAllEnvs(); }
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

it('follows the clock and clears when the ZIP is blanked', async () => {
  const [zip, setZip] = createSignal('90210');
  const [clock, setClock] = createSignal(new Date('2026-06-21T12:00:00').getTime());
  const { times, dispose } = createRoot((dispose) => ({ dispose, times: createZipSunTimes(zip, clock) }));
  try {
    await vi.waitFor(() => expect(times()).not.toBeNull());
    const summer = times()!;
    setClock(new Date('2026-12-21T12:00:00').getTime());
    expect(times()!.sunset - times()!.sunrise).toBeLessThan(summer.sunset - summer.sunrise);
    setZip('');
    expect(times()).toBeNull();
  } finally { dispose(); }
});
