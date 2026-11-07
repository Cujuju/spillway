import { describe, expect, it } from 'vitest';
import { ACTIVITY_BOARD_VERSION, DEFAULT_ACTIVITY_BOARD, normalizeActivityBoard } from './activityBoard';

describe('normalizeActivityBoard', () => {
  it('keeps valid panels, defaults a bad metric and drops unknown kinds', () => {
    const tiles = { kind: 'tile', id: 'a' };
    expect(normalizeActivityBoard({ version: ACTIVITY_BOARD_VERSION, tiles, panels: { a: { kind: 'trend', metric: 'bytes' }, b: { kind: 'pie' } } }))
      .toEqual({ version: ACTIVITY_BOARD_VERSION, tiles, panels: { a: { kind: 'trend', metric: 'cost' } } });
  });

  it('keeps an emptied board instead of restoring the default', () => {
    const empty = { version: ACTIVITY_BOARD_VERSION, tiles: null, panels: {} };
    expect(normalizeActivityBoard(empty)).toEqual(empty);
  });

  it('drops a height stored by older versions: the board always fills the page', () => {
    expect(normalizeActivityBoard({ tiles: { kind: 'tile', id: 'a' }, panels: { a: { kind: 'trend' } }, heightPx: 900 })).not.toHaveProperty('heightPx');
  });

  it('adds Model and effort below an older board once, so removing it later sticks', () => {
    const tiles = { kind: 'tile', id: 'a' };
    const upgraded = normalizeActivityBoard({ tiles, panels: { a: { kind: 'trend', metric: 'cost' } } });
    expect(upgraded).toEqual({
      version: ACTIVITY_BOARD_VERSION,
      tiles: { kind: 'split', dir: 'column', sizes: [2, 1], children: [tiles, { kind: 'tile', id: 'efforts' }] },
      panels: { a: { kind: 'trend', metric: 'cost' }, efforts: { kind: 'efforts', metric: 'cost' } },
    });
    const removed = { version: ACTIVITY_BOARD_VERSION, tiles, panels: { a: { kind: 'trend', metric: 'cost' } } };
    expect(normalizeActivityBoard(removed)).toEqual(removed);
  });

  it('upgrades an emptied older board to Model and effort alone, and leaves a board that has one', () => {
    expect(normalizeActivityBoard({ tiles: null, panels: {} }).tiles).toEqual({ kind: 'tile', id: 'efforts' });
    const has = { tiles: { kind: 'tile', id: 'x' }, panels: { x: { kind: 'efforts', metric: 'cost' } } };
    expect(normalizeActivityBoard(has)).toEqual({ version: ACTIVITY_BOARD_VERSION, ...has });
  });

  it('falls back to the default for anything else', () => {
    expect(normalizeActivityBoard(undefined)).toBe(DEFAULT_ACTIVITY_BOARD);
    expect(normalizeActivityBoard({ tiles: 'x', panels: {} })).toBe(DEFAULT_ACTIVITY_BOARD);
  });
});
