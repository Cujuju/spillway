import type { LimitWindow } from './types';

/** Percentage points either side of even pace still counted as 'on'. */
export const ON_PACE_BAND = 5;
const FULL = 100;

export type PaceState = 'over' | 'on' | 'under';

export interface WindowPace {
  /** Share of the window elapsed, 0–100. */
  elapsedPercent: number;
  /** usedPercent − elapsedPercent, percentage points; positive = using faster than even pace. */
  deltaPercent: number;
  /** 'on' within ON_PACE_BAND points of even pace, else 'over' / 'under'. */
  state: PaceState;
}

/** Pace of one window at `now` (epoch ms); null when it cannot be judged. */
export function windowPace(window: LimitWindow, now: number): WindowPace | null {
  const { durationMs, resetsAt, usedPercent, status } = window;
  if (durationMs === null || durationMs <= 0 || resetsAt === null || usedPercent === null
    || status === 'rejected' || usedPercent >= FULL) return null;

  const reset = Date.parse(resetsAt);
  if (Number.isNaN(reset) || now >= reset) return null;

  const start = reset - durationMs;
  const elapsedMs = now - start;
  const elapsedShare = elapsedMs / durationMs;
  if (elapsedMs <= 0) return null;

  const elapsedPercent = Math.min(FULL, Math.max(0, elapsedShare * FULL));
  const deltaPercent = usedPercent - elapsedPercent;
  const state = deltaPercent > ON_PACE_BAND ? 'over' : deltaPercent < -ON_PACE_BAND ? 'under' : 'on';
  return { elapsedPercent, deltaPercent, state };
}
