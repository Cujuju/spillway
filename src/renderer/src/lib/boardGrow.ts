import type { TileNode } from '@cujuju/solidjs-tiling-window-manager';

/** Adds `id` as a bottom row `addPx` tall under a `boardPx` board; once the board grows by `addPx`, old rows keep their heights. */
export function appendRow(tree: TileNode | undefined, id: string, boardPx: number, addPx: number): TileNode {
  const tile: TileNode = { kind: 'tile', id };
  if (!tree) return tile;
  if (tree.kind === 'split' && tree.dir === 'column') {
    const total = tree.sizes.reduce((a, b) => a + b, 0);
    return { ...tree, sizes: [...tree.sizes, (total * addPx) / boardPx], children: [...tree.children, tile] };
  }
  return { kind: 'split', dir: 'column', sizes: [boardPx, addPx], children: [tree, tile] };
}
