import { describe, expect, it } from 'vitest';
import { ACTIVITY_BOARD_VERSION, DEFAULT_ACTIVITY_BOARD, normalizeActivityBoard } from './activityBoard';

describe('normalizeActivityBoard', () => {
  it('keeps valid panels, defaults a bad metric and drops unknown kinds', () => {
    const tiles = { kind: 'tile', id: 'a' };
    expect(normalizeActivityBoard({ version: ACTIVITY_BOARD_VERSION, tiles, panels: { a: { kind: 'trend', metric: 'bytes' }, b: { kind: 'pie' } } }))
      .toEqual({ version: ACTIVITY_BOARD_VERSION, tiles, panels: { a: { kind: 'trend', metric: 'cost' } }, heightPx: null });
  });

  it('keeps an emptied board instead of restoring the default', () => {
    const empty = { version: ACTIVITY_BOARD_VERSION, tiles: null, panels: {}, heightPx: null };
    expect(normalizeActivityBoard(empty)).toEqual(empty);
  });

  it('drops a height stored by older versions: it described another layout', () => {
    expect(normalizeActivityBoard({ tiles: { kind: 'tile', id: 'a' }, panels: { a: { kind: 'trend' } }, heightPx: 900 }).heightPx).toBeNull();
  });

  it('keeps a current board’s height and drops a bad one', () => {
    const board = (heightPx: unknown) => ({ version: ACTIVITY_BOARD_VERSION, tiles: { kind: 'tile', id: 'a' }, panels: { a: { kind: 'trend' } }, heightPx });
    expect(normalizeActivityBoard(board(900)).heightPx).toBe(900);
    expect(normalizeActivityBoard(board(-1)).heightPx).toBeNull();
    expect(normalizeActivityBoard(board('900')).heightPx).toBeNull();
  });

  const comboRow = { kind: 'split', dir: 'row', sizes: [1, 1, 1], children: ['combo-1', 'combo-2', 'combo-3'].map((id) => ({ kind: 'tile', id })) };
  const comparePanels = { 'combo-1': { kind: 'combo', metric: 'cost' }, 'combo-2': { kind: 'combo', metric: 'cost' }, 'combo-3': { kind: 'combo', metric: 'cost' }, compare: { kind: 'compare', metric: 'cost' } };

  it('adds Model and effort, then the combination cards and Compare, below a version 1 board once', () => {
    const tiles = { kind: 'tile', id: 'a' };
    const upgraded = normalizeActivityBoard({ tiles, panels: { a: { kind: 'trend', metric: 'cost' } } });
    const withEfforts = { kind: 'split', dir: 'column', sizes: [2, 1], children: [tiles, { kind: 'tile', id: 'efforts' }] };
    expect(upgraded).toEqual({
      version: ACTIVITY_BOARD_VERSION,
      tiles: { kind: 'split', dir: 'column', sizes: [3, 1, 2], children: [withEfforts, comboRow, { kind: 'tile', id: 'compare' }] },
      panels: { a: { kind: 'trend', metric: 'cost' }, efforts: { kind: 'efforts', metric: 'cost' }, ...comparePanels },
      heightPx: null,
    });
    const removed = { version: ACTIVITY_BOARD_VERSION, tiles, panels: { a: { kind: 'trend', metric: 'cost' } }, heightPx: null };
    expect(normalizeActivityBoard(removed)).toEqual(removed);
  });

  it('adds only the combination cards and Compare to a version 2 board', () => {
    const tiles = { kind: 'tile', id: 'x' };
    const upgraded = normalizeActivityBoard({ version: 2, tiles, panels: { x: { kind: 'efforts', metric: 'cost' } }, heightPx: 700 });
    expect(upgraded.tiles).toEqual({ kind: 'split', dir: 'column', sizes: [3, 1, 2], children: [tiles, comboRow, { kind: 'tile', id: 'compare' }] });
    expect(upgraded.heightPx).toBeNull();
  });

  it('upgrades an emptied older board to the added tiles alone, and leaves a board that has them', () => {
    expect(normalizeActivityBoard({ version: 2, tiles: null, panels: {} }).tiles).toEqual({ kind: 'split', dir: 'column', sizes: [1, 2], children: [comboRow, { kind: 'tile', id: 'compare' }] });
    const has = { tiles: { kind: 'tile', id: 'x' }, panels: { x: { kind: 'efforts', metric: 'cost' }, y: { kind: 'compare', metric: 'cost' } } };
    expect(normalizeActivityBoard(has)).toEqual({ version: ACTIVITY_BOARD_VERSION, ...has, heightPx: null });
  });

  it('keeps a combination card’s combination and drops one on other kinds', () => {
    const board = normalizeActivityBoard({ version: ACTIVITY_BOARD_VERSION, tiles: null, panels: { c: { kind: 'combo', combo: '["m","high"]' }, t: { kind: 'trend', combo: 'x' } } });
    expect(board.panels).toEqual({ c: { kind: 'combo', metric: 'cost', combo: '["m","high"]' }, t: { kind: 'trend', metric: 'cost' } });
  });

  it('falls back to the default for anything else', () => {
    expect(normalizeActivityBoard(undefined)).toBe(DEFAULT_ACTIVITY_BOARD);
    expect(normalizeActivityBoard({ tiles: 'x', panels: {} })).toBe(DEFAULT_ACTIVITY_BOARD);
  });
});
