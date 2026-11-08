/** The Activity page's chart tiles: which charts exist and how they are tiled. */

export const ACTIVITY_PANEL_KINDS = ['trend', 'cache', 'heatmap', 'rhythm', 'models', 'accounts', 'clients', 'efforts'] as const;
export type ActivityPanelKind = (typeof ACTIVITY_PANEL_KINDS)[number];
export const ACTIVITY_METRICS = ['cost', 'tokens', 'requests'] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

export interface ActivityPanelSpec {
  kind: ActivityPanelKind;
  /** What the chart counts; the cache chart ignores it. */
  metric: ActivityMetric;
}

/** Bumped when a release adds a chart every saved board should gain once. */
export const ACTIVITY_BOARD_VERSION = 2;
/** Version 2 moved Model and effort from a card below the board into this tile. */
const EFFORTS_TILE_ID = 'efforts';
/** An upgraded board keeps two thirds of its height; Model and effort gets the rest. */
const UPGRADE_SHARES = [2, 1];

export interface ActivityBoard {
  /** Saved boards older than ACTIVITY_BOARD_VERSION gain its charts on load. */
  version: number;
  /**
   * Tile tree in @cujuju/solidjs-tiling-window-manager's shape. Stored as given; the renderer
   * validates it with that package's normalize(), which main cannot import (it ships Solid UI).
   */
  tiles: unknown;
  /** Tile id → chart. Ids missing from the tree are dropped when the tree changes. */
  panels: Record<string, ActivityPanelSpec>;
  /** The board's height once a tile was resized vertically: the sum of its rows. Null fills the page. */
  heightPx: number | null;
}

const tile = (id: string) => ({ kind: 'tile', id });

const split = (dir: 'row' | 'column', sizes: number[], ...children: unknown[]) => ({ kind: 'split', dir, sizes, children });
const EFFORTS_PANEL: ActivityPanelSpec = { kind: 'efforts', metric: 'cost' };

/** API cost beside Cache hit, Heatmap beside Models, then Model and effort. Shares favour the wider chart. */
export const DEFAULT_ACTIVITY_BOARD: ActivityBoard = {
  version: ACTIVITY_BOARD_VERSION,
  tiles: split('column', [1, 1.4, 1],
    split('row', [1.4, 1], tile('trend'), tile('cache')), split('row', [1, 1.3], tile('heatmap'), tile('models')), tile(EFFORTS_TILE_ID)),
  panels: {
    trend: { kind: 'trend', metric: 'cost' },
    cache: { kind: 'cache', metric: 'cost' },
    heatmap: { kind: 'heatmap', metric: 'cost' },
    models: { kind: 'models', metric: 'cost' },
    [EFFORTS_TILE_ID]: EFFORTS_PANEL,
  },
  heightPx: null,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v);

/** Version 1 → 2: Model and effort joins as a bottom row, unless the board already has one. Older heights described other layouts. */
function upgrade(board: ActivityBoard): ActivityBoard {
  if (Object.values(board.panels).some((panel) => panel.kind === EFFORTS_PANEL.kind)) return { ...board, version: ACTIVITY_BOARD_VERSION, heightPx: null };
  return {
    version: ACTIVITY_BOARD_VERSION,
    tiles: board.tiles === null ? tile(EFFORTS_TILE_ID) : split('column', UPGRADE_SHARES, board.tiles, tile(EFFORTS_TILE_ID)),
    panels: { ...board.panels, [EFFORTS_TILE_ID]: EFFORTS_PANEL },
    heightPx: null,
  };
}

/** Keeps valid panels and a tree object (null when every chart was removed), upgraded to the current version; anything else is the default board. */
export function normalizeActivityBoard(raw: unknown): ActivityBoard {
  if (!isObj(raw) || !isObj(raw.panels) || !(raw.tiles === null || isObj(raw.tiles))) return DEFAULT_ACTIVITY_BOARD;
  const panels = Object.fromEntries(Object.entries(raw.panels).flatMap(([id, v]): [string, ActivityPanelSpec][] =>
    id && isObj(v) && oneOf(v.kind, ACTIVITY_PANEL_KINDS)
      ? [[id, { kind: v.kind, metric: oneOf(v.metric, ACTIVITY_METRICS) ? v.metric : 'cost' }]]
      : []));
  const heightPx = typeof raw.heightPx === 'number' && Number.isFinite(raw.heightPx) && raw.heightPx > 0 ? raw.heightPx : null;
  const board = { version: ACTIVITY_BOARD_VERSION, tiles: raw.tiles, panels, heightPx };
  return raw.version === ACTIVITY_BOARD_VERSION ? board : upgrade(board);
}
