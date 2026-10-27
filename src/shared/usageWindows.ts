import type { HistorySample, LimitWindow, UsageSnapshot } from './types';

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

/** True when the window's reset time recorded in `a` passed by the time of `b`. */
export function resetBetween(a: HistorySample, b: HistorySample, id: string, key: string): boolean {
  const resetAt = a.resets?.[id]?.[key];
  return resetAt !== undefined && resetAt <= Date.parse(b.at);
}

/** Percent of one window used between two samples, or null when either lacks it. After a reset, all of `b` is new use. */
export function consumedBetween(a: HistorySample, b: HistorySample, id: string, key: string): number | null {
  const before = a.used[id]?.[key];
  const after = b.used[id]?.[key];
  if (before === undefined || after === undefined) return null;
  // Without a recorded reset, a drop is a reset in old samples or a source correction, not use.
  return resetBetween(a, b, id, key) ? after : Math.max(0, after - before);
}
