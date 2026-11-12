/** The Activity page's chart tiles: which charts exist and how they are tiled. */

export const ACTIVITY_PANEL_KINDS = ['trend', 'cache', 'heatmap', 'rhythm', 'models', 'accounts', 'clients', 'efforts', 'combo', 'compare'] as const;
export type ActivityPanelKind = (typeof ACTIVITY_PANEL_KINDS)[number];
export const ACTIVITY_METRICS = ['cost', 'tokens', 'requests'] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

export interface ActivityPanelSpec {
  kind: ActivityPanelKind;
  /** What the chart counts; the cache chart ignores it. */
  metric: ActivityMetric;
  /** A combination card's combination (comboKey). Absent: the costliest combination in range not on another card. */
  combo?: string;
}

/** Bumped when a release adds a chart every saved board should gain once. */
export const ACTIVITY_BOARD_VERSION = 3;
/** Version 2 moved Model and effort from a card below the board into this tile. */
const EFFORTS_TILE_ID = 'efforts';
/** An upgraded board keeps two thirds of its height; Model and effort gets the rest. */
const UPGRADE_SHARES = [2, 1];
/** Version 3 added three combination cards in a row and Compare below them (#156). */
const COMBO_TILE_IDS = ['combo-1', 'combo-2', 'combo-3'];
const COMPARE_TILE_ID = 'compare';
/** An upgraded board keeps half its height; the cards get a sixth and Compare, a long table, a third. */
const COMPARE_UPGRADE_SHARES = [3, 1, 2];

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
const comboRow = () => split('row', COMBO_TILE_IDS.map(() => 1), ...COMBO_TILE_IDS.map(tile));
const COMPARE_PANELS: Record<string, ActivityPanelSpec> = {
  ...Object.fromEntries(COMBO_TILE_IDS.map((id) => [id, { kind: 'combo', metric: 'cost' }])),
  [COMPARE_TILE_ID]: { kind: 'compare', metric: 'cost' },
};

/** API cost beside Cache hit, Heatmap beside Models, Model and effort, the combination cards, then Compare. Shares favour the wider chart and the long table. */
export const DEFAULT_ACTIVITY_BOARD: ActivityBoard = {
  version: ACTIVITY_BOARD_VERSION,
  tiles: split('column', [1, 1.4, 1, 1, 1.8],
    split('row', [1.4, 1], tile('trend'), tile('cache')), split('row', [1, 1.3], tile('heatmap'), tile('models')), tile(EFFORTS_TILE_ID),
    comboRow(), tile(COMPARE_TILE_ID)),
  panels: {
    trend: { kind: 'trend', metric: 'cost' },
    cache: { kind: 'cache', metric: 'cost' },
    heatmap: { kind: 'heatmap', metric: 'cost' },
    models: { kind: 'models', metric: 'cost' },
    [EFFORTS_TILE_ID]: EFFORTS_PANEL,
    ...COMPARE_PANELS,
  },
  heightPx: null,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v);

/** Version 1 → 2: Model and effort joins as a bottom row, unless the board already has one. */
function addEfforts(board: ActivityBoard): ActivityBoard {
  if (Object.values(board.panels).some((panel) => panel.kind === EFFORTS_PANEL.kind)) return board;
  return { ...board, tiles: board.tiles === null ? tile(EFFORTS_TILE_ID) : split('column', UPGRADE_SHARES, board.tiles, tile(EFFORTS_TILE_ID)),
    panels: { ...board.panels, [EFFORTS_TILE_ID]: EFFORTS_PANEL } };
}

/** Version 2 → 3: the combination cards and Compare join as bottom rows, unless the board already has either. */
function addCompare(board: ActivityBoard): ActivityBoard {
  if (Object.values(board.panels).some((panel) => panel.kind === 'combo' || panel.kind === 'compare')) return board;
  return { ...board, tiles: board.tiles === null ? split('column', COMPARE_UPGRADE_SHARES.slice(1), comboRow(), tile(COMPARE_TILE_ID))
    : split('column', COMPARE_UPGRADE_SHARES, board.tiles, comboRow(), tile(COMPARE_TILE_ID)), panels: { ...board.panels, ...COMPARE_PANELS } };
}

/** Applies each version's additions once. Older heights described other layouts. */
function upgrade(board: ActivityBoard, from: number): ActivityBoard {
  const withEfforts = from < 2 ? addEfforts(board) : board;
  return { ...addCompare(withEfforts), version: ACTIVITY_BOARD_VERSION, heightPx: null };
}

/** Keeps valid panels and a tree object (null when every chart was removed), upgraded to the current version; anything else is the default board. */
export function normalizeActivityBoard(raw: unknown): ActivityBoard {
  if (!isObj(raw) || !isObj(raw.panels) || !(raw.tiles === null || isObj(raw.tiles))) return DEFAULT_ACTIVITY_BOARD;
  const panels = Object.fromEntries(Object.entries(raw.panels).flatMap(([id, v]): [string, ActivityPanelSpec][] =>
    id && isObj(v) && oneOf(v.kind, ACTIVITY_PANEL_KINDS)
      ? [[id, { kind: v.kind, metric: oneOf(v.metric, ACTIVITY_METRICS) ? v.metric : 'cost', ...(v.kind === 'combo' && typeof v.combo === 'string' ? { combo: v.combo } : {}) }]]
      : []));
  const heightPx = typeof raw.heightPx === 'number' && Number.isFinite(raw.heightPx) && raw.heightPx > 0 ? raw.heightPx : null;
  const board = { version: ACTIVITY_BOARD_VERSION, tiles: raw.tiles, panels, heightPx };
  return raw.version === ACTIVITY_BOARD_VERSION ? board : upgrade(board, typeof raw.version === 'number' ? raw.version : 1);
}
