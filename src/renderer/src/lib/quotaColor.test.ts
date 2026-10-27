import { describe, expect, it } from 'vitest';
import { isExhausted, quotaColor } from './quotaColor';

describe('quotaColor', () => {
  it('is red when nothing is left or the window is rejected', () => {
    expect(quotaColor(100, false)).toBe('var(--color-red)');
    expect(quotaColor(120, false)).toBe('var(--color-red)');
    expect(quotaColor(10, true)).toBe('var(--color-red)');
  });

  it('is pure green when full and pure amber halfway', () => {
    expect(quotaColor(0, false)).toBe('color-mix(in oklch, var(--color-green) 100%, var(--color-amber))');
    expect(quotaColor(50, false)).toBe('color-mix(in oklch, var(--color-amber) 100%, var(--color-red))');
  });

  it('blends linearly within each half', () => {
    expect(quotaColor(75, false)).toBe('color-mix(in oklch, var(--color-amber) 50%, var(--color-red))');
    expect(quotaColor(20, false)).toBe('color-mix(in oklch, var(--color-green) 60%, var(--color-amber))');
  });
});

describe('isExhausted', () => {
  it('needs the window fully used or rejected', () => {
    expect(isExhausted(100, false)).toBe(true);
    expect(isExhausted(99, false)).toBe(false);
    expect(isExhausted(null, false)).toBe(false);
    expect(isExhausted(null, true)).toBe(true);
  });
});
