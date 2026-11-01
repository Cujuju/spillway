import { moonAltitude } from './moon';
import { HORIZON_Y, peakAltitude } from './sky';
import { sunAltitude } from './solarTimes';
import type { Coordinates } from './zipCoordinates';

/** Top of the sun's yearly-highest arc as a share of the sky's height. */
export const ARC_TOP_Y = 0.1;
/** Altitude samples per day: every 15 minutes. */
const TRACK_STEPS = 96;
const MINUTES_PER_DAY = 1440;
/** Water left below the deepest point of a path. */
const WATER_MARGIN_PX = 6;
/** Catmull-Rom to cubic Bezier: control points sit a sixth of the neighbour span away. */
const CATMULL_ROM = 6;

type Point = [number, number];

/** One smooth path through the points: Catmull-Rom segments as cubic Beziers. */
export function smoothPath(points: Point[]): string {
  if (points.length === 0) return '';
  const f = (v: number) => v.toFixed(2);
  let d = `M${f(points[0]![0])},${f(points[0]![1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[i - 1] ?? points[i]!, points[i]!, points[i + 1]!, points[i + 2] ?? points[i + 1]!];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / CATMULL_ROM)},${f(p1[1] + (p2[1] - p0[1]) / CATMULL_ROM)} `
      + `${f(p2[0] - (p3[0] - p1[0]) / CATMULL_ROM)},${f(p2[1] - (p3[1] - p1[1]) / CATMULL_ROM)} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

/** Day shares where altitude samples cross the horizon, linearly interpolated. */
export function horizonCrossings(samples: { x: number; altitude: number }[]): { x: number; rising: boolean }[] {
  const out: { x: number; rising: boolean }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!;
    if ((a.altitude < 0) === (b.altitude < 0)) continue;
    out.push({ x: a.x + (b.x - a.x) * (a.altitude / (a.altitude - b.altitude)), rising: b.altitude >= 0 });
  }
  return out;
}

/**
 * Pixel geometry for the sun and moon over the local day. One slope through the horizon;
 * below it, depth eases (tanh) so each whole path fits in the water.
 */
export function rhythmScene(width: number, height: number, now: number, coordinates: Coordinates) {
  const horizon = HORIZON_Y * height;
  const scale = (horizon - ARC_TOP_Y * height) / peakAltitude(coordinates.latitude);
  const depth = Math.max(1, height - horizon - WATER_MARGIN_PX);
  const y = (altitude: number) => altitude >= 0 ? horizon - scale * altitude : horizon + depth * Math.tanh(-altitude * scale / depth);
  const today = new Date(now);
  const clock = (today.getHours() * 60 + today.getMinutes()) / MINUTES_PER_DAY;
  const body = (altitude: (t: number, c: Coordinates) => number) => {
    const samples = Array.from({ length: TRACK_STEPS + 1 }, (_, i) => {
      const t = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, (i * MINUTES_PER_DAY) / TRACK_STEPS).getTime();
      return { x: i / TRACK_STEPS, altitude: altitude(t, coordinates) };
    });
    const current = altitude(now, coordinates);
    return {
      path: smoothPath(samples.map((s) => [s.x * width, y(s.altitude)])),
      crossings: horizonCrossings(samples).map((c) => ({ x: c.x * width, rising: c.rising })),
      y: y(current),
      up: current > 0,
    };
  };
  return { width, height, horizon, x: clock * width, sun: body(sunAltitude), moon: body(moonAltitude) };
}

export type RhythmScene = ReturnType<typeof rhythmScene>;
