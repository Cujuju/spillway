import type { HistorySample, LimitWindow, UsageSnapshot, WindowSummary } from './types';

/**
 * When a window next resets, once its reset at `resetAt` is past `now`. Fixed-cadence windows
 * reset every `durationMs`; others restart on next use, so null.
 */
export function nextResetAfter(w: Pick<LimitWindow, 'durationMs' | 'resetCadence'>, resetAt: number, now: number): number | null {
  if (w.resetCadence !== 'fixed' || !w.durationMs) return null;
  const periods = Math.floor((now - resetAt) / w.durationMs) + 1;
  return resetAt + periods * w.durationMs;
}

/**
 * A window past its reset holds no usage. The proxy keeps reporting the old value until it
 * observes the account again, so readers roll it to zero themselves.
 */
export function rollWindow(w: LimitWindow, now: number): LimitWindow {
  if (!w.resetsAt || Date.parse(w.resetsAt) > now) return w;
  const next = nextResetAfter(w, Date.parse(w.resetsAt), now);
  return {
    ...w,
    usedPercent: w.usedPercent === null ? null : 0,
    resetsAt: next === null ? null : new Date(next).toISOString(),
    status: w.status === null ? null : 'allowed',
  };
}

/** Rolls every window whose reset has passed; returns `snapshot` itself when none has. */
export function rollPastResets(snapshot: UsageSnapshot, now: number): UsageSnapshot {
  let changed = false;
  const credentials = snapshot.credentials.map((c) => {
    const windows = c.windows.map((w) => rollWindow(w, now));
    if (windows.every((w, i) => w === c.windows[i])) return c;
    changed = true;
    return { ...c, windows };
  });
  return changed ? { ...snapshot, credentials } : snapshot;
}

/** One settled history point per 5 min is finer than any weekly-chart pixel and keeps 14 days near 4k points. */
export const HISTORY_SAMPLE_SPACING_MS = 5 * 60_000;

/** A gap over two reading intervals (one failed lookup allowed) means the app missed time. */
const MISSED_GAP_READINGS = 2;

/** Longest gap between readings that still counts as watching. Stored readings are a sample spacing apart, so the wider interval holds for both. */
export const missedReadingGapMs = (refreshMs: number): number => MISSED_GAP_READINGS * Math.max(refreshMs, HISTORY_SAMPLE_SPACING_MS);

/** Readings of one reset differ by request latency (seconds; Codex up to 3 s seen). Any later window resets at least 5 hours on. */
export const RESET_READING_TOLERANCE_MS = 60_000;

/** True when two reset readings name the same window; the one contract for window identity. */
export function sameReset(a: number, b: number): boolean {
  return Math.abs(a - b) <= RESET_READING_TOLERANCE_MS;
}

/** True when `b` is in a later window than `a`: it reports a different reset, or none after `a`'s reset passed. */
export function resetBetween(a: HistorySample, b: HistorySample, id: string, key: string): boolean {
  const resetAt = a.resets?.[id]?.[key];
  if (resetAt === undefined) return false;
  const nextResetAt = b.resets?.[id]?.[key];
  return nextResetAt === undefined ? resetAt <= Date.parse(b.at) : !sameReset(resetAt, nextResetAt);
}

/** Percent of one window used between two samples, or null when either lacks it. After a reset, all of `b` is new use. */
export function consumedBetween(a: HistorySample, b: HistorySample, id: string, key: string): number | null {
  const before = a.used[id]?.[key];
  const after = b.used[id]?.[key];
  if (before === undefined || after === undefined) return null;
  // Without a recorded reset, a drop is a reset in old samples or a source correction, not use.
  return resetBetween(a, b, id, key) ? after : Math.max(0, after - before);
}

/** When a summarised window stops counting: its reset, or earlier when a new window replaced it. */
export const windowEnd = (s: WindowSummary): number => s.endedAt ?? s.resetAt;

const FULL_PERCENT = 100;
const SCOPE_SEPARATOR = ' · ';

const scopePrefix = (label: string): string | null => {
  const idx = label.lastIndexOf(SCOPE_SEPARATOR);
  return idx > 0 ? label.slice(0, idx) : null;
};

const isWindowExhausted = (w: LimitWindow): boolean =>
  w.status === 'rejected' || (w.usedPercent !== null && w.usedPercent >= FULL_PERCENT);

/** Longer exhausted window in the same scope capping `target`, or null. */
export function exhaustedBlocker(target: LimitWindow, windows: readonly LimitWindow[]): LimitWindow | null {
  if (target.durationMs === null) return null;
  const targetScope = target.scoped ? scopePrefix(target.label) : null;
  for (const other of windows) {
    if (other.key === target.key || other.scoped !== target.scoped) continue;
    if (other.durationMs === null || other.durationMs <= target.durationMs) continue;
    if (target.scoped && (!targetScope || scopePrefix(other.label) !== targetScope)) continue;
    if (isWindowExhausted(other)) return other;
  }
  return null;
}

/** Minimum lead time before the prior reset to count as an early provider reset. */
const MIN_EARLY_RESET_MS = 10 * 60_000;

export interface EarlyReset {
  detectedAt: number;
  previousResetAt: number;
  newResetAt: number;
  aheadByMs: number;
}

/** Most recent early provider reset still matching `currentResetsAt`, or null. */
export function earlyResetFor(
  history: readonly HistorySample[],
  id: string,
  key: string,
  currentResetsAt: string | null,
): EarlyReset | null {
  const currentMs = currentResetsAt ? Date.parse(currentResetsAt) : null;
  for (let i = history.length - 1; i > 0; i--) {
    const prev = history[i - 1]!;
    const next = history[i]!;
    const prevReset = prev.resets?.[id]?.[key];
    const nextReset = next.resets?.[id]?.[key];
    if (prevReset === undefined || nextReset === undefined || sameReset(prevReset, nextReset)) continue;
    const detectedAt = Date.parse(next.at);
    const aheadByMs = prevReset - detectedAt;
    if (aheadByMs < MIN_EARLY_RESET_MS) continue;
    if (currentMs !== null && !sameReset(nextReset, currentMs)) return null;
    return { detectedAt, previousResetAt: prevReset, newResetAt: nextReset, aheadByMs };
  }
  return null;
}
