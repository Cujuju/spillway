import { computeTileLayout, normalize, tileIds, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
import { describe, expect, it, vi } from 'vitest';
import { appendRow } from './boardGrow';

// Geometry tests never mount the toolkit's components.
vi.hoisted(() => vi.stubGlobal('window', { document: { addEventListener: () => {} } }));

const tile = (id: string): TileNode => ({ kind: 'tile', id });
const size = { width: 1000, height: 700 };
const addPx = 320;
const options = { gapPx: 12, minSizes: new Map(['a', 'b', 'c', 'new'].map((id) => [id, { width: 100, height: id === 'a' ? 220 : 150 }])) };
const column: TileNode = { kind: 'split', dir: 'column', sizes: [1, 8], children: [tile('a'), tile('b')] };

describe('appendRow', () => {
  it('starts an empty board', () => {
    expect(appendRow(undefined, 'new', size, addPx, options)).toEqual(tile('new'));
  });
  it.each([
    ['tile', tile('a')],
    ['row', { kind: 'split', dir: 'row', sizes: [1, 1], children: [tile('a'), tile('b')] }],
    ['tabs', { kind: 'tabs', active: 1, children: [tile('a'), tile('b')] }],
    ['column with minimum-clamped shares', column],
    ['column with collapsed row', { ...column, children: [{ ...tile('a'), collapsed: { edge: 'top' } }, tile('b')] }],
  ] as [string, TileNode][])('preserves rendered heights and positions after normalization: %s', (_, tree) => {
    const before = computeTileLayout(tree, size, options);
    const next = normalize(appendRow(tree, 'new', size, addPx, options))!;
    expect(tileIds(next)).toEqual([...tileIds(tree), 'new']);
    const after = computeTileLayout(next, { ...size, height: size.height + addPx + options.gapPx }, options);
    for (const id of tileIds(tree)) {
      expect(after.tiles.get(id)!.height).toBeCloseTo(before.tiles.get(id)!.height);
      expect(after.tiles.get(id)!.y).toBeCloseTo(before.tiles.get(id)!.y);
    }
    expect(after.tiles.get('new')!.height).toBeCloseTo(addPx);
    expect(after.tiles.get('new')!.y).toBeCloseTo(size.height + options.gapPx);
  });
});
