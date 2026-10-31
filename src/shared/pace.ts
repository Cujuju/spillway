import type { LimitWindow } from './types';

/** Percentage points either side of even pace still counted as 'on'. */
export const ON_PACE_BAND = 5;
/** Share of the window that must pass before judging pace; 5% = 15 minutes of a 5-hour window. */
export const PACE_MIN_ELAPSED_SHARE = 0.05;
const FULL = 100;

export type PaceState = 'over' | 'on' | 'under';

export interface WindowPace {
  /** Share of the window elapsed, 0–100. */
  elapsedPercent: number;
  /** usedPercent − elapsedPercent, percentage points; positive = using faster than even pace. */
  deltaPercent: number;
  /** 'on' within ON_PACE_BAND points of even pace, else 'over' / 'under'. */
  state: PaceState;
  /** Used percent at reset at the average rate so far, capped at 100. */
  projectedPercent: number;
  /** Epoch ms when the window reaches 100% at its average rate so far, only if that is before resetsAt; else null. */
  runsOutAt: number | null;
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
  if (elapsedShare < PACE_MIN_ELAPSED_SHARE) return null;

  const elapsedPercent = Math.min(FULL, Math.max(0, elapsedShare * FULL));
  const deltaPercent = usedPercent - elapsedPercent;
  const state = deltaPercent > ON_PACE_BAND ? 'over' : deltaPercent < -ON_PACE_BAND ? 'under' : 'on';
  const projectedPercent = Math.min(FULL, usedPercent * FULL / elapsedPercent);
  const projected = usedPercent > 0 ? start + elapsedMs * (FULL / usedPercent) : null;
  return { elapsedPercent, deltaPercent, state, projectedPercent, runsOutAt: projected !== null && projected < reset ? projected : null };
}
