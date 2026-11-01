import { expect, it, vi } from 'vitest';
import { moonAltitude } from './moon';
import { horizonCrossings, rhythmScene, smoothPath } from './rhythmScene';
import { HORIZON_Y } from './sky';
import { sunAltitude } from './solarTimes';

const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_MS = 29.530588853 * 86_400_000;
const EQUATOR = { latitude: 0, longitude: 0 };
const HOUR_MS = 3_600_000;

it('draws one smooth path through every sample', () => {
  const d = smoothPath([[0, 0], [10, 5], [20, 0]]);
  expect(d.startsWith('M0.00,0.00')).toBe(true);
  expect(d.match(/C/g)).toHaveLength(2);
  expect(d).toContain(' 10.00,5.00C');
  expect(d.endsWith(' 20.00,0.00')).toBe(true);
});

it('interpolates where samples cross the horizon', () => {
  expect(horizonCrossings([{ x: 0, altitude: -1 }, { x: 0.5, altitude: 1 }, { x: 1, altitude: -3 }]))
    .toEqual([{ x: 0.25, rising: true }, { x: 0.625, rising: false }]);
});

it('keeps the moon opposite the sun at full moon and with it at new moon', () => {
  for (const [cycles, sign] of [[100.5, 1], [100, -1]] as const) {
    const t0 = NEW_MOON_MS + cycles * SYNODIC_MS;
    for (let h = -6; h <= 6; h += 3) {
      const t = t0 + h * HOUR_MS;
      // Mean phase is within about half a day; the moon also strays up to 5 degrees from the ecliptic.
      expect(Math.abs(moonAltitude(t, EQUATOR) + sign * sunAltitude(t, EQUATOR))).toBeLessThan(15);
    }
  }
});

it('lays out a mid-latitude day: sun up at noon, down at midnight, every path inside the sky', () => {
  try {
    vi.stubEnv('TZ', 'America/New_York');
    const width = 680, height = 230;
    const nyc = { latitude: 40.7128, longitude: -74.006 };
    const noon = rhythmScene(width, height, new Date('2026-10-31T13:00:00').getTime(), nyc);
    expect(noon.horizon).toBeCloseTo(HORIZON_Y * height);
    expect(noon.sun.up).toBe(true);
    expect(noon.sun.y).toBeLessThan(noon.horizon);
    expect(noon.sun.crossings.map((c) => c.rising)).toEqual([true, false]);
    expect(noon.x).toBeCloseTo((13 / 24) * width);
    const night = rhythmScene(width, height, new Date('2026-10-31T01:00:00').getTime(), nyc);
    expect(night.sun.up).toBe(false);
    expect(night.sun.y).toBeGreaterThan(night.horizon);
    expect(night.sun.y).toBeLessThan(height);
    const ys = [noon.sun.path, noon.moon.path].flatMap((d) => [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1])));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(height);
  } finally { vi.unstubAllEnvs(); }
});
