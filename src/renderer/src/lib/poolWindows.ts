import type { Credential } from '@shared/types';
import type { SeriesPoint } from './poolHistory';

export interface WindowChoice {
  value: string;
  label: string;
}

/** One provider: each of its windows by key, shortest first. */
export function keyChoices(credentials: Credential[]): WindowChoice[] {
  const seen = new Map<string, { label: string; durationMs: number | null }>();
  for (const c of credentials) for (const w of c.windows) if (!seen.has(w.key)) seen.set(w.key, w);
  return [...seen]
    .sort(([, a], [, b]) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity))
    .map(([value, w]) => ({ value, label: w.label }));
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

/** The account-wide window key of this length, or null when the provider has none. */
export function keyForDuration(credentials: Credential[], durationMs: number): string | null {
  for (const c of credentials) for (const w of c.windows) if (!w.scoped && w.durationMs === durationMs) return w.key;
  return null;
}

/** Linear value at `t`; null outside the series. Points are in time order. */
export function valueAt(points: SeriesPoint[], t: number): number | null {
  if (!points.length || t < points[0]!.t || t > points.at(-1)!.t) return null;
  const i = points.findIndex((p) => p.t >= t);
  const b = points[i]!;
  if (b.t === t || i === 0) return b.remaining;
  const a = points[i - 1]!;
  return a.remaining + ((b.remaining - a.remaining) * (t - a.t)) / (b.t - a.t);
}
