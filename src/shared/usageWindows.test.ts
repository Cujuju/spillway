import { describe, expect, it } from 'vitest';
import type { Credential, LimitWindow, UsageSnapshot } from './types';
import { consumedBetween, earlyResetFor, exhaustedBlocker, resetBetween, rollPastResets } from './usageWindows';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const win = (resetsAt: string | null, status: LimitWindow['status'] = 'rejected'): LimitWindow => ({
  key: 'five_hour', label: '5-hour', usedPercent: 100, resetsAt, status, durationMs: 5 * 3_600_000, scoped: false, resetCadence: null,
});
const snap = (...windows: LimitWindow[]): UsageSnapshot => ({
  fetchedAt: '', strategy: 'soonest-reset', credentials: [{ id: 'a', windows } as Credential],
});

describe('rollPastResets', () => {
  it('zeroes a window whose reset passed and clears its reset and rejection', () => {
    const rolled = rollPastResets(snap(win('2026-10-25T11:00:00Z')), NOW).credentials[0]!.windows[0]!;
    expect(rolled).toMatchObject({ usedPercent: 0, resetsAt: null, status: 'allowed' });
  });
  it('moves a fixed-cadence window to its next period', () => {
    const fixed = { ...win('2026-10-25T01:00:00Z'), resetCadence: 'fixed' as const };
    expect(rollPastResets(snap(fixed), NOW).credentials[0]!.windows[0]!.resetsAt).toBe('2026-10-25T16:00:00.000Z');
  });
  it('returns the same snapshot when nothing reset', () => {
    const s = snap(win('2026-10-25T13:00:00Z'), win(null));
    expect(rollPastResets(s, NOW)).toBe(s);
  });
});

describe('resetBetween', () => {
  const before = { at: '2026-10-25T11:55:00Z', used: {}, resets: { a: { k: NOW - 1_000 } } };
  it.each([NOW - 3_000, NOW - 1_000, NOW + 1_000])('ignores the same reset reported with jitter (%s)', (reset) => {
    expect(resetBetween(before, { at: '2026-10-25T12:00:00Z', used: {}, resets: { a: { k: reset } } }, 'a', 'k')).toBe(false);
  });
  it('recognizes a passed reset when the next sample has no reset or a later window', () => {
    const after = { at: '2026-10-25T12:00:00Z', used: {} };
    expect(resetBetween(before, after, 'a', 'k')).toBe(true);
    expect(resetBetween(before, { ...after, resets: { a: { k: NOW + 5 * 3_600_000 } } }, 'a', 'k')).toBe(true);
  });
  it('recognizes an earlier reset after a reset credit restarts the window', () => {
    const credited = { ...before, resets: { a: { k: NOW + 8 * 3_600_000 } } };
    expect(resetBetween(credited, { at: '2026-10-25T12:00:00Z', used: {}, resets: { a: { k: NOW + 5 * 3_600_000 } } }, 'a', 'k')).toBe(true);
  });
  it('recognizes an advanced reset before the previous jittered reset has elapsed', () => {
    const lateReset = { ...before, resets: { a: { k: NOW + 1_000 } } };
    const after = { at: '2026-10-25T12:00:00Z', used: {}, resets: { a: { k: NOW + 7 * 24 * 3_600_000 } } };
    expect(resetBetween(lateReset, after, 'a', 'k')).toBe(true);
  });
});

describe('consumedBetween', () => {
  const at = (iso: string, used: number, reset?: number) => ({ at: iso, used: { a: { k: used } }, resets: reset === undefined ? undefined : { a: { k: reset } } });
  it('counts the later value in full after a recorded reset', () => {
    expect(consumedBetween(at('2026-10-25T10:00:00Z', 90, NOW - 1), at('2026-10-25T12:00:00Z', 3), 'a', 'k')).toBe(3);
  });
  it('counts the later value in full after a reset credit moves the reset earlier', () => {
    expect(consumedBetween(at('2026-10-25T11:55:00Z', 3, NOW + 8 * 3_600_000), at('2026-10-25T12:00:00Z', 2, NOW + 5 * 3_600_000), 'a', 'k')).toBe(2);
  });
  it('counts only the increase when reset readings straddle the boundary', () => {
    expect(consumedBetween(at('2026-10-25T11:55:00Z', 90, NOW - 1_000), at('2026-10-25T12:00:00Z', 92, NOW + 1_000), 'a', 'k')).toBe(2);
  });
  it('counts increases and ignores unexplained drops', () => {
    expect(consumedBetween(at('2026-10-25T10:00:00Z', 10), at('2026-10-25T12:00:00Z', 14), 'a', 'k')).toBe(4);
    expect(consumedBetween(at('2026-10-25T10:00:00Z', 10, NOW + 1), at('2026-10-25T12:00:00Z', 9), 'a', 'k')).toBe(0);
  });
  it('is null when either sample lacks the window', () => {
    expect(consumedBetween({ at: '2026-10-25T10:00:00Z', used: {} }, at('2026-10-25T12:00:00Z', 1), 'a', 'k')).toBeNull();
  });
});

describe('exhaustedBlocker', () => {
  const H5 = 5 * 3_600_000;
  const D7 = 7 * 24 * 3_600_000;
  const mk = (key: string, label: string, durationMs: number, usedPercent: number, scoped = false): LimitWindow => ({
    key, label, usedPercent, resetsAt: null, status: usedPercent >= 100 ? 'rejected' : 'allowed', durationMs, scoped, resetCadence: null,
  });

  it('returns an exhausted longer account-wide window capping a shorter one', () => {
    const five = mk('five_hour', '5-hour', H5, 0);
    const week = mk('seven_day', 'Weekly', D7, 100);
    expect(exhaustedBlocker(five, [five, week])).toBe(week);
    expect(exhaustedBlocker(week, [five, week])).toBeNull();
  });

  it('returns null when the longer window is not exhausted', () => {
    const five = mk('five_hour', '5-hour', H5, 0);
    const week = mk('seven_day', 'Weekly', D7, 85);
    expect(exhaustedBlocker(five, [five, week])).toBeNull();
  });

  it('pairs scoped windows only within the same scope prefix', () => {
    const g5 = mk('ag_summary:gemini-5h', '5-hour', H5, 0, false);
    const gw = mk('ag_summary:gemini-weekly', 'Weekly', D7, 20, false);
    const p5 = mk('ag_summary:3p-5h', 'Claude & GPT · 5-hour', H5, 0, true);
    const pw = mk('ag_summary:3p-weekly', 'Claude & GPT · Weekly', D7, 100, true);
    const all = [g5, gw, p5, pw];
    expect(exhaustedBlocker(p5, all)).toBe(pw);
    expect(exhaustedBlocker(g5, all)).toBeNull();
  });
});

describe('earlyResetFor', () => {
  const sample = (iso: string, resetIso: string) => ({
    at: iso,
    used: { a: { w: 10 } },
    resets: { a: { w: Date.parse(resetIso) } },
  });

  it('detects a reset that jumped to a new window well before the prior reset', () => {
    const history = [
      sample('2026-11-23T22:00:27Z', '2026-11-29T08:30:14Z'),
      sample('2026-11-23T22:05:27Z', '2026-11-30T20:03:03Z'),
    ];
    const er = earlyResetFor(history, 'a', 'w', '2026-11-30T20:03:03Z');
    expect(er).not.toBeNull();
    expect(er!.previousResetAt).toBe(Date.parse('2026-11-29T08:30:14Z'));
    expect(er!.newResetAt).toBe(Date.parse('2026-11-30T20:03:03Z'));
    expect(er!.aheadByMs).toBeGreaterThan(5 * 24 * 3_600_000);
  });

  it('returns null after the window rolls over to a later reset', () => {
    const history = [
      sample('2026-11-23T22:00:27Z', '2026-11-29T08:30:14Z'),
      sample('2026-11-23T22:05:27Z', '2026-11-30T20:03:03Z'),
    ];
    expect(earlyResetFor(history, 'a', 'w', '2026-12-07T20:03:03Z')).toBeNull();
  });

  it('ignores normal resets occurring after the prior reset passed', () => {
    const history = [
      sample('2026-11-23T18:40:00Z', '2026-11-23T18:41:16Z'),
      sample('2026-11-23T19:02:24Z', '2026-11-23T23:41:16Z'),
    ];
    expect(earlyResetFor(history, 'a', 'w', '2026-11-23T23:41:16Z')).toBeNull();
  });
});
