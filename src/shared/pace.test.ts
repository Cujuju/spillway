import { describe, expect, it } from 'vitest';
import { ON_PACE_BAND, windowPace } from './pace';
import type { LimitWindow } from './types';

const H = 60 * 60_000;
const DURATION = 5 * H;
const START = Date.UTC(2026, 9, 26, 12);
const RESET = START + DURATION;
const NOW = START + DURATION / 2;
const window = (overrides: Partial<LimitWindow> = {}): LimitWindow => ({
  key: 'five_hour', label: '5-hour', usedPercent: 50, resetsAt: new Date(RESET).toISOString(),
  status: 'allowed', durationMs: DURATION, scoped: false, resetCadence: 'on_use', ...overrides,
});

describe('windowPace', () => {
  it.each([
    { durationMs: null },
    { durationMs: 0 },
    { durationMs: -DURATION },
    { resetsAt: null },
    { resetsAt: 'invalid' },
    { usedPercent: null },
    { status: 'rejected' as const },
    { usedPercent: 100 },
    { usedPercent: 101 },
  ])('cannot judge a window with %o', (overrides) => {
    expect(windowPace(window(overrides), NOW)).toBeNull();
  });

  it('cannot judge at or after reset', () => {
    expect(windowPace(window(), RESET)).toBeNull();
    expect(windowPace(window(), RESET + H)).toBeNull();
  });

  it('judges immediately after start, but not at or before it', () => {
    expect(windowPace(window(), START - H)).toBeNull();
    expect(windowPace(window(), START)).toBeNull();
    expect(windowPace(window(), START + 1)?.elapsedPercent).toBeGreaterThan(0);
  });

  it.each([
    { delta: -ON_PACE_BAND - 1, state: 'under' },
    { delta: -ON_PACE_BAND, state: 'on' },
    { delta: 0, state: 'on' },
    { delta: ON_PACE_BAND, state: 'on' },
    { delta: ON_PACE_BAND + 1, state: 'over' },
  ])('classifies a $delta point difference as $state', ({ delta, state }) => {
    expect(windowPace(window({ usedPercent: 50 + delta }), NOW)).toMatchObject({
      elapsedPercent: 50, deltaPercent: delta, state,
    });
  });

  it('handles zero usage', () => {
    expect(windowPace(window({ usedPercent: 0 }), NOW)).toEqual({
      elapsedPercent: 50, deltaPercent: -50, state: 'under',
    });
  });
});
