import { computeTileLayout, type TileLayoutOptions, type TileNode, type TileSize } from '@cujuju/solidjs-tiling-window-manager';

/** Adds a bottom row while preserving the old rows' rendered pixels, including minimum-size clamping and gaps. */
export function appendRow(tree: TileNode | undefined, id: string, size: TileSize, addPx: number, options: TileLayoutOptions): TileNode {
  const tile: TileNode = { kind: 'tile', id };
  if (!tree) return tile;
  if (tree.kind === 'split' && tree.dir === 'column') {
    const expanded = { ...tree, children: tree.children.map((child) => ({ ...child, collapsed: undefined })) };
    const geometry = computeTileLayout(expanded, size, options);
    const handle = geometry.handles.find((entry) => entry.split === expanded);
    const sizes = handle?.sizes ?? tree.sizes;
    const space = size.height - options.gapPx * (tree.children.length - 1);
    const total = sizes.reduce((a, b) => a + b, 0);
    return { ...tree, sizes: [...sizes, total * addPx / space], children: [...tree.children, tile] };
  }
  return { kind: 'split', dir: 'column', sizes: [size.height, addPx], children: [tree, tile] };
}
