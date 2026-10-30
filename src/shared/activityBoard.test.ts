import { describe, expect, it } from 'vitest';
import { BOARD_MAX_PX, BOARD_MIN_PX, DEFAULT_ACTIVITY_BOARD, normalizeActivityBoard } from './activityBoard';

describe('normalizeActivityBoard', () => {
  it('keeps valid panels, defaults a bad metric and drops unknown kinds', () => {
    const tiles = { kind: 'tile', id: 'a' };
    expect(normalizeActivityBoard({ tiles, panels: { a: { kind: 'trend', metric: 'bytes' }, b: { kind: 'pie' } } }))
      .toEqual({ tiles, panels: { a: { kind: 'trend', metric: 'cost' } }, heightPx: null });
  });

  it('keeps an emptied board instead of restoring the default', () => {
    expect(normalizeActivityBoard({ tiles: null, panels: {} })).toEqual({ tiles: null, panels: {}, heightPx: null });
  });

  it('keeps a stored board height within bounds and drops a non-number', () => {
    const board = (heightPx: unknown) => normalizeActivityBoard({ tiles: null, panels: {}, heightPx }).heightPx;
    expect(board(812.4)).toBe(812);
    expect(board(10)).toBe(BOARD_MIN_PX);
    expect(board(1e9)).toBe(BOARD_MAX_PX);
    expect(board('900')).toBeNull();
    expect(board(Number.NaN)).toBeNull();
  });

  it('falls back to the default for anything else', () => {
    expect(normalizeActivityBoard(undefined)).toBe(DEFAULT_ACTIVITY_BOARD);
    expect(normalizeActivityBoard({ tiles: 'x', panels: {} })).toBe(DEFAULT_ACTIVITY_BOARD);
  });
});
