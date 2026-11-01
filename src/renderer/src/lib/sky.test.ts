import { expect, it, vi } from 'vitest';
import { skyGeometry } from './sky';
import { solarTimes } from './solarTimes';
import { zipCoordinates } from './zipCoordinates';

it('bounds twilight near polar day with an exact 24-hour period and no stacked stars', async () => {
  try {
    vi.stubEnv('TZ', 'America/Anchorage');
    const times = solarTimes(new Date('2026-05-10T12:00:00'), (await zipCoordinates('99723'))!);
    expect(times.sunset).toBeLessThan(times.sunrise);
    const sky = skyGeometry(times);
    expect(sky.stops.at(-1)! - sky.stops[0]!).toBeCloseTo(24);
    expect(sky.stops.every((stop, i) => i === 0 || stop >= sky.stops[i - 1]!)).toBe(true);
    expect(sky.nightHours).toBeCloseTo(0);
    expect(sky.stars).toEqual([]);
  } finally { vi.unstubAllEnvs(); }
});

it('places wrapped-night stars only in the dark interval, faded near its ends', () => {
  const sky = skyGeometry({ sunrise: 8, sunset: 2 });
  expect(sky.stops).toEqual([6.5, 8, 9.5, 24.5, 26, 27.5, 30.5]);
  expect(sky.stars).toHaveLength(22);
  expect(sky.stars.every((s) => s.x * 24 >= 3.5 && s.x * 24 < 6.5)).toBe(true);
  expect(sky.stars.every((s) => s.fade >= 0 && s.fade <= 1)).toBe(true);
  expect(sky.stars.some((s) => s.fade < 1)).toBe(true);
});

it('masks the day water to the same daylight span as the sky', () => {
  expect(skyGeometry({ sunrise: 6, sunset: 18 }).daylightMask)
    .toBe('repeating-linear-gradient(90deg, transparent 18.75%, #000 31.25%, #000 68.75%, transparent 81.25%, transparent 118.75%)');
  expect(skyGeometry({ sunrise: 0, sunset: 24 }).daylightMask).toBe('linear-gradient(#000, #000)');
});

it('handles polar day and polar night', () => {
  const day = skyGeometry({ sunrise: 0, sunset: 24 });
  expect(day.gradient).toBe('var(--sky-day)');
  expect(day.stars).toEqual([]);
  const night = skyGeometry({ sunrise: 12, sunset: 12 });
  expect(night.gradient).toBe('var(--sky-night)');
  expect(night.nightHours).toBe(24);
  expect(new Set(night.stars.map((s) => s.x)).size).toBe(22);
});

it('keeps the fallback 6/18 stops and spreads stars from dusk across the night', () => {
  const sky = skyGeometry();
  expect(sky.stops).toEqual([4.5, 6, 7.5, 16.5, 18, 19.5, 28.5]);
  expect(sky.stars.every((s) => { const h = s.x * 24; return h >= 19.5 || h < 4.5; })).toBe(true);
  expect(new Set(sky.stars.map((s) => s.size))).toEqual(new Set([0, 1, 2]));
});
