import type { ObservedSpan, WindowSummary } from '@shared/types';
import { windowEnd } from '@shared/usageWindows';

/** A finished window, or a stretch between windows that held none: no use while the app watched, untracked otherwise. */
export type PastEntry = { kind: 'window'; summary: WindowSummary } | { kind: 'idle'; from: number; to: number; trackedMs: number };

export const windowStart = (s: WindowSummary, durationMs: number | null): number => (durationMs ? s.resetAt - durationMs : s.firstSampleAt);

/** Time within [from, to] that the spans cover; spans are in time order and never overlap. */
function coveredMs(spans: ObservedSpan[], from: number, to: number): number {
  return spans.reduce((sum, s) => sum + Math.max(0, Math.min(to, s.to) - Math.max(from, s.from)), 0);
}

/** One account window's past, newest first: finished windows and the gaps between. Inputs are pre-filtered; gaps up to `maxGapMs` are jitter. */
export function pastTimeline(summaries: WindowSummary[], spans: ObservedSpan[], durationMs: number | null, now: number, maxGapMs: number): PastEntry[] {
  const entries: PastEntry[] = [];
  const idle = (from: number, to: number) => {
    if (to - from > maxGapMs) entries.push({ kind: 'idle', from, to, trackedMs: coveredMs(spans, from, to) });
  };
  // Finished unused windows are pruned in time; one not yet pruned is idle time, not a window.
  const windows = summaries.filter((s) => s.peak > 0 || windowEnd(s) > now);
  let cursor = spans[0]?.from ?? null;
  for (const s of windows) {
    const start = windowStart(s, durationMs);
    if (cursor !== null) idle(cursor, start);
    if (windowEnd(s) <= now) entries.push({ kind: 'window', summary: s });
    cursor = Math.max(cursor ?? start, windowEnd(s));
  }
  if (cursor !== null) idle(cursor, now);
  return entries.reverse();
}
