import { describe, expect, it } from 'vitest';
import { compactDuration, quotaPercent } from './format';

const H = 3_600_000;

describe('compactDuration', () => {
  it('shows two largest units', () => {
    expect(compactDuration(55 * H)).toBe('2d 7h');
    expect(compactDuration(3 * H + 12 * 60_000)).toBe('3h 12m');
    expect(compactDuration(45 * 60_000)).toBe('45m');
    expect(compactDuration(1000)).toBe('now');
  });
});

describe('quotaPercent', () => {
  it('shows three significant digits, truncated', () => {
    expect(quotaPercent(45.37)).toBe('45.3%');
    expect(quotaPercent(7.259)).toBe('7.25%');
    expect(quotaPercent(0.0042)).toBe('0.0042%');
    expect(quotaPercent(99.96)).toBe('99.9%');
    expect(quotaPercent(100)).toBe('100%');
    expect(quotaPercent(0)).toBe('0%');
    expect(quotaPercent(null)).toBe('—');
  });
});
