import { describe, expect, it } from 'vitest';
import type { Credential, LimitWindow, UsageSnapshot } from './types';
import { consumedBetween, rollPastResets } from './usageWindows';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const win = (resetsAt: string | null, status: LimitWindow['status'] = 'rejected'): LimitWindow => ({
  key: 'five_hour', label: '5-hour', usedPercent: 100, resetsAt, status, durationMs: 5 * 3_600_000, scoped: false,
});
const snap = (...windows: LimitWindow[]): UsageSnapshot => ({
  fetchedAt: '', strategy: 'soonest-reset', credentials: [{ id: 'a', windows } as Credential],
});

describe('rollPastResets', () => {
  it('zeroes a window whose reset passed and clears its reset and rejection', () => {
    const rolled = rollPastResets(snap(win('2026-10-25T11:00:00Z')), NOW).credentials[0]!.windows[0]!;
    expect(rolled).toMatchObject({ usedPercent: 0, resetsAt: null, status: 'allowed' });
  });
  it('returns the same snapshot when nothing reset', () => {
    const s = snap(win('2026-10-25T13:00:00Z'), win(null));
    expect(rollPastResets(s, NOW)).toBe(s);
  });
});

describe('consumedBetween', () => {
  const at = (iso: string, used: number, reset?: number) => ({ at: iso, used: { a: { k: used } }, resets: reset === undefined ? undefined : { a: { k: reset } } });
  it('counts the later value in full after a recorded reset', () => {
    expect(consumedBetween(at('2026-10-25T10:00:00Z', 90, NOW - 1), at('2026-10-25T12:00:00Z', 3), 'a', 'k')).toBe(3);
  });
  it('counts increases and ignores unexplained drops', () => {
    expect(consumedBetween(at('2026-10-25T10:00:00Z', 10), at('2026-10-25T12:00:00Z', 14), 'a', 'k')).toBe(4);
    expect(consumedBetween(at('2026-10-25T10:00:00Z', 10, NOW + 1), at('2026-10-25T12:00:00Z', 9), 'a', 'k')).toBe(0);
  });
  it('is null when either sample lacks the window', () => {
    expect(consumedBetween({ at: '2026-10-25T10:00:00Z', used: {} }, at('2026-10-25T12:00:00Z', 1), 'a', 'k')).toBeNull();
  });
});
