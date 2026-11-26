import type { Credential, LimitWindow } from '@shared/types';
import type { AccountShare } from './poolCapacity';
import type { SeriesPoint } from './poolHistory';
import { accountsFor, blockingWindow, remainingIn } from './forecastState';

const FULL = 100;
const MAX_POINTS_PER_COLUMN = 4;
const SPARSE_POINTS_PER_PIXEL = 2;

export interface WindowChoice {
  value: string;
  label: string;
}

/**
 * Several providers: account-wide windows grouped by length, shortest first, so Claude's and
 * Codex's 5-hour (or weekly) windows plot together. Keys differ by provider; lengths line up.
 */
export function durationChoices(pools: Credential[][]): WindowChoice[] {
  const seen = new Map<number, string>();
  for (const creds of pools) {
    for (const c of creds) for (const w of c.windows) if (!w.scoped && w.durationMs && !seen.has(w.durationMs)) seen.set(w.durationMs, w.label);
  }
  return [...seen].sort(([a], [b]) => a - b).map(([ms, label]) => ({ value: String(ms), label }));
}

/**
 * Chart selection ids. Account-wide windows of one length chart together across providers
 * (each provider's weekly); a scoped window (model, spend) charts alone.
 */
export const lengthLineId = (ms: string) => `length:${ms}`;
export const scopedLineId = (key: string) => `scoped:${key}`;

/** One provider's scoped windows (model, feature, spend), shortest first. */
export function scopedChoices(credentials: Credential[]): WindowChoice[] {
  const seen = new Map<string, LimitWindow>();
  for (const c of credentials) for (const w of c.windows) if (w.scoped && !seen.has(w.key)) seen.set(w.key, w);
  return [...seen.values()]
    .sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity))
    .map((w) => ({ value: w.key, label: w.label }));
}

/** The account-wide window key of this length, or null when the provider has none. */
export function keyForDuration(credentials: Credential[], durationMs: number): string | null {
  for (const c of credentials) for (const w of c.windows) if (!w.scoped && w.durationMs === durationMs) return w.key;
  return null;
}

export interface PoolSegment {
  id: string;
  /** Fraction of the pool this account holds; segments' shares sum to 1. */
  share: number;
  usedPercent: number;
  rejected: boolean;
}

/** One bar segment per account: width by pool share, fill by usable remaining quota. */
export function poolSegments(credentials: Credential[], key: string, shares: Map<string, AccountShare>): PoolSegment[] {
  return accountsFor(credentials, key, shares).map((a) => ({
    id: a.id, share: a.share, usedPercent: FULL - remainingIn(a), rejected: !!blockingWindow(a),
  }));
}

/** Soonest reset of window `key` after `now` across the accounts; null when none is pending. */
export function nextResetAt(credentials: Credential[], key: string, now: number): number | null {
  let soonest: number | null = null;
  for (const c of credentials) {
    const at = Date.parse(c.windows.find((w) => w.key === key)?.resetsAt ?? '');
    if (at > now && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

function timeBound(points: readonly SeriesPoint[], t: number, afterEqual = false): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const time = points[mid]!.t;
    if (afterEqual ? time > t : time >= t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Appends the live reading at `now`, keeping timestamps strictly sorted and `< now` before it even after clock rollbacks. */
export function appendLivePoint(series: readonly SeriesPoint[], now: number, remaining: number): SeriesPoint[] {
  let sorted = true;
  let allBefore = true;
  let prev = -Infinity;
  for (const p of series) {
    if (p.t >= now) allBefore = false;
    if (p.t < prev) sorted = false;
    prev = p.t;
  }
  const base = allBefore ? (sorted ? series : [...series].sort((a, b) => a.t - b.t))
    : series.filter((p) => p.t < now).sort((a, b) => a.t - b.t);
  return [...base, { t: now, remaining }];
}

/** Linear value at `t`; null outside the series. Points are in time order. */
export function valueAt(points: SeriesPoint[], t: number): number | null {
  if (!points.length || t < points[0]!.t || t > points.at(-1)!.t) return null;
  const i = timeBound(points, t);
  const b = points[i]!;
  if (b.t === t || i === 0) return b.remaining;
  const a = points[i - 1]!;
  return a.remaining + ((b.remaining - a.remaining) * (t - a.t)) / (b.t - a.t);
}

/** Clips sorted points with one neighbor on each side and retains each pixel column's shape. */
export function decimateSeries(points: readonly SeriesPoint[], from: number, to: number, pixelWidth: number): SeriesPoint[] {
  const start = Math.max(0, timeBound(points, from) - 1);
  const end = Math.min(points.length, timeBound(points, to, true) + 1);
  const sparseLimit = Math.max(MAX_POINTS_PER_COLUMN, Math.ceil(pixelWidth) * SPARSE_POINTS_PER_PIXEL);
  if (pixelWidth <= 0 || to <= from || end - start <= sparseLimit) return points.slice(start, end);

  const columns = Math.max(1, Math.floor(pixelWidth));
  const column = (t: number) => Math.min(columns - 1, Math.floor(((t - from) / (to - from)) * columns));
  const last = end - 1;
  const result = [points[start]!];
  for (let first = start + 1; first < last;) {
    const bucket = column(points[first]!.t);
    let min = first;
    let max = first;
    let next = first + 1;
    for (; next < last && column(points[next]!.t) === bucket; next++) {
      if (points[next]!.remaining < points[min]!.remaining) min = next;
      if (points[next]!.remaining > points[max]!.remaining) max = next;
    }
    const indices = [...new Set([first, min, max, next - 1])].sort((a, b) => a - b);
    for (const i of indices) result.push(points[i]!);
    first = next;
  }
  result.push(points[last]!);
  return result;
}
