import { describe, expect, it } from 'vitest';
import { DEFAULT_ACTIVITY_BOARD, normalizeActivityBoard } from './activityBoard';

describe('normalizeActivityBoard', () => {
  it('keeps valid panels, defaults a bad metric and drops unknown kinds', () => {
    const tiles = { kind: 'tile', id: 'a' };
    expect(normalizeActivityBoard({ tiles, panels: { a: { kind: 'trend', metric: 'bytes' }, b: { kind: 'pie' } } }))
      .toEqual({ tiles, panels: { a: { kind: 'trend', metric: 'cost' } } });
  });

  it('keeps an emptied board instead of restoring the default', () => {
    expect(normalizeActivityBoard({ tiles: null, panels: {} })).toEqual({ tiles: null, panels: {} });
  });

  it('falls back to the default for anything else', () => {
    expect(normalizeActivityBoard(undefined)).toBe(DEFAULT_ACTIVITY_BOARD);
    expect(normalizeActivityBoard({ tiles: 'x', panels: {} })).toBe(DEFAULT_ACTIVITY_BOARD);
  });
});
