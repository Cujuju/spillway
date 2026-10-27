import { describe, expect, it } from 'vitest';
import { compactDuration } from './format';

const H = 3_600_000;

describe('compactDuration', () => {
  it('shows two largest units', () => {
    expect(compactDuration(55 * H)).toBe('2d 7h');
    expect(compactDuration(3 * H + 12 * 60_000)).toBe('3h 12m');
    expect(compactDuration(45 * 60_000)).toBe('45m');
    expect(compactDuration(1000)).toBe('now');
  });
});
