import { describe, expect, it } from 'vitest';
import { compactDuration, relativeFuture } from './format';

const H = 3_600_000;

describe('compactDuration', () => {
  it('shows two largest units', () => {
    expect(compactDuration(55 * H)).toBe('2d 7h');
    expect(compactDuration(3 * H + 12 * 60_000)).toBe('3h 12m');
    expect(compactDuration(45 * 60_000)).toBe('45m');
    expect(compactDuration(1000)).toBe('now');
  });
});

describe('relativeFuture', () => {
  it('rounds to the natural unit', () => {
    const now = Date.parse('2026-10-25T00:00:00Z');
    expect(relativeFuture(null, now)).toBe('No reset pending');
    expect(relativeFuture(new Date(now + 50 * H).toISOString(), now)).toBe('in 2 days');
    expect(relativeFuture(new Date(now + 3 * H).toISOString(), now)).toBe('in 3 hours');
    expect(relativeFuture(new Date(now + 20 * 60_000).toISOString(), now)).toBe('in 20 min');
  });
});
