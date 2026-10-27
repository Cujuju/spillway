import type { Credential } from '@shared/types';
import type { AccountShare } from './poolCapacity';
import type { SeriesPoint } from './poolHistory';

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

/** One bar segment per account with data in window `key`: width by pool share, fill by its own use. */
export function poolSegments(credentials: Credential[], key: string, shares: Map<string, AccountShare>): PoolSegment[] {
  return credentials.flatMap((c) => {
    const s = shares.get(c.id);
    const w = c.windows.find((x) => x.key === key);
    if (!s || !w || w.usedPercent === null) return [];
    return [{ id: c.id, share: s.share, usedPercent: w.usedPercent, rejected: w.status === 'rejected' }];
  });
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

/** Linear value at `t`; null outside the series. Points are in time order. */
export function valueAt(points: SeriesPoint[], t: number): number | null {
  if (!points.length || t < points[0]!.t || t > points.at(-1)!.t) return null;
  const i = points.findIndex((p) => p.t >= t);
  const b = points[i]!;
  if (b.t === t || i === 0) return b.remaining;
  const a = points[i - 1]!;
  return a.remaining + ((b.remaining - a.remaining) * (t - a.t)) / (b.t - a.t);
}
