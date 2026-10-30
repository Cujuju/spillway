import { describe, expect, it } from 'vitest';
import type { ObservedSpan, WindowSummary } from '@shared/types';
import { pastTimeline } from './pastTimeline';

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const MAX_GAP = 10 * 60_000;
const T0 = Date.parse('2026-10-01T17:00:00Z');
const week = (n: number, peak: number): WindowSummary => ({
  credentialId: 'a', key: 'seven_day', firstSampleAt: T0 + n * WEEK, lastSampleAt: T0 + (n + 1) * WEEK - HOUR,
  resetAt: T0 + (n + 1) * WEEK, endedAt: null, peak, exhaustedAt: null,
});
const span = (from: number, to: number): ObservedSpan => ({ credentialId: 'a', key: 'seven_day', from, to });
const shape = (entries: ReturnType<typeof pastTimeline>) =>
  entries.map((e) => (e.kind === 'window' ? ['window', e.summary.peak] : ['idle', (e.to - e.from) / WEEK, e.trackedMs / WEEK]));

describe('pastTimeline', () => {
  it('lists back-to-back fixed weeks newest first with no gap rows', () => {
    expect(shape(pastTimeline([week(0, 40), week(1, 90)], [span(T0, T0 + 2 * WEEK)], WEEK, T0 + 2 * WEEK, MAX_GAP))).toEqual([['window', 90], ['window', 40]]);
  });

  it('shows a skipped week as tracked no-use when the app was reading through it', () => {
    const entries = pastTimeline([week(0, 40), week(2, 90)], [span(T0, T0 + 3 * WEEK)], WEEK, T0 + 3 * WEEK, MAX_GAP);
    expect(shape(entries)).toEqual([['window', 90], ['idle', 1, 1], ['window', 40]]);
  });

  it('marks the skipped week untracked where no reading covers it', () => {
    const spans = [span(T0, T0 + WEEK), span(T0 + 2 * WEEK, T0 + 3 * WEEK)];
    expect(shape(pastTimeline([week(0, 40), week(2, 90)], spans, WEEK, T0 + 3 * WEEK, MAX_GAP))).toEqual([['window', 90], ['idle', 1, 0], ['window', 40]]);
  });

  it('treats a finished unused window not yet pruned as idle, and stops at the window in progress', () => {
    const entries = pastTimeline([week(0, 40), week(1, 0), week(2, 0)], [span(T0, T0 + 2.5 * WEEK)], WEEK, T0 + 2.5 * WEEK, MAX_GAP);
    expect(shape(entries)).toEqual([['idle', 1, 1], ['window', 40]]);
  });

  it('shows idle time before the first window and after the last when the app watched it', () => {
    const entries = pastTimeline([week(1, 40)], [span(T0, T0 + 3 * WEEK)], WEEK, T0 + 3 * WEEK, MAX_GAP);
    expect(shape(entries)).toEqual([['idle', 1, 1], ['window', 40], ['idle', 1, 1]]);
  });

  it('ignores gaps within the reading tolerance', () => {
    const late = { ...week(1, 90), resetAt: T0 + 2 * WEEK + MAX_GAP };
    expect(shape(pastTimeline([week(0, 40), late], [span(T0, late.resetAt)], WEEK, late.resetAt, MAX_GAP))).toEqual([['window', 90], ['window', 40]]);
  });
});
