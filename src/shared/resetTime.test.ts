import { describe, expect, it } from 'vitest';
import { clockText, resetText, untilText } from './resetTime';

const M = 60_000;
const H = 60 * M;
/** Local noon, so same-day offsets stay on the same date in any timezone. */
const NOW = new Date(2026, 9, 26, 12, 0).getTime();
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

describe('untilText', () => {
  it('shows every unit down to minutes', () => {
    expect(untilText(55 * H + 12 * M)).toBe('2d 7h 12m');
    expect(untilText(48 * H)).toBe('2d 0h 0m');
    expect(untilText(3 * H + 12 * M)).toBe('3h 12m');
    expect(untilText(45 * M)).toBe('45m');
  });
});

describe('clockText', () => {
  it('shows only the time today', () => {
    expect(clockText(NOW + 2 * H, NOW)).toBe(time(NOW + 2 * H));
  });
  it('names the weekday within the week and the date beyond it', () => {
    const in3d = NOW + 72 * H;
    const in7d = NOW + 7 * 24 * H;
    expect(clockText(in3d, NOW)).toBe(new Date(in3d).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
    expect(clockText(in7d, NOW)).toBe(new Date(in7d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  });
});

describe('resetText', () => {
  it('joins time left and reset time', () => {
    const at = NOW + 3 * H + 12 * M;
    expect(resetText(new Date(at).toISOString(), NOW)).toBe(`in 3h 12m · ${time(at)}`);
    expect(resetText(NOW + 30_000, NOW)).toBe(`any moment · ${time(NOW + 30_000)}`);
  });
});
