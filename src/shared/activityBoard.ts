/** The Activity page's chart tiles: which charts exist and how they are tiled. */

export const ACTIVITY_PANEL_KINDS = ['trend', 'cache', 'heatmap', 'rhythm', 'models', 'accounts', 'clients'] as const;
export type ActivityPanelKind = (typeof ACTIVITY_PANEL_KINDS)[number];
export const ACTIVITY_METRICS = ['cost', 'tokens', 'requests'] as const;
export type ActivityMetric = (typeof ACTIVITY_METRICS)[number];

export interface ActivityPanelSpec {
  kind: ActivityPanelKind;
  /** What the chart counts; the cache chart ignores it. */
  metric: ActivityMetric;
}

export interface ActivityBoard {
  /**
   * Tile tree in @cujuju/solidjs-tiling-window-manager's shape. Stored as given; the renderer
   * validates it with that package's normalize(), which main cannot import (it ships Solid UI).
   */
  tiles: unknown;
  /** Tile id → chart. Ids missing from the tree are dropped when the tree changes. */
  panels: Record<string, ActivityPanelSpec>;
  /** Board height once the user sized it or added a row below; null fills the page. Tiles keep their pixel heights while it is set. */
  heightPx: number | null;
}

/** Shortest board a stored height may set (one short chart row) and a sanity cap on a corrupt value. */
export const BOARD_MIN_PX = 240;
export const BOARD_MAX_PX = 20_000;

const tile = (id: string) => ({ kind: 'tile', id });

const row = (sizes: number[], ...children: unknown[]) => ({ kind: 'split', dir: 'row', sizes, children });

/** Two rows: API cost beside Cache hit, then Heatmap beside Models. Shares favour the wider chart. */
export const DEFAULT_ACTIVITY_BOARD: ActivityBoard = {
  tiles: {
    kind: 'split', dir: 'column', sizes: [1, 1.4],
    children: [row([1.4, 1], tile('trend'), tile('cache')), row([1, 1.3], tile('heatmap'), tile('models'))],
  },
  panels: {
    trend: { kind: 'trend', metric: 'cost' },
    cache: { kind: 'cache', metric: 'cost' },
    heatmap: { kind: 'heatmap', metric: 'cost' },
    models: { kind: 'models', metric: 'cost' },
  },
  heightPx: null,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v);

/** Keeps valid panels and a tree object (null when every chart was removed); anything else is the default board. */
export function normalizeActivityBoard(raw: unknown): ActivityBoard {
  if (!isObj(raw) || !isObj(raw.panels) || !(raw.tiles === null || isObj(raw.tiles))) return DEFAULT_ACTIVITY_BOARD;
  const panels = Object.fromEntries(Object.entries(raw.panels).flatMap(([id, v]): [string, ActivityPanelSpec][] =>
    id && isObj(v) && oneOf(v.kind, ACTIVITY_PANEL_KINDS)
      ? [[id, { kind: v.kind, metric: oneOf(v.metric, ACTIVITY_METRICS) ? v.metric : 'cost' }]]
      : []));
  const h = raw.heightPx;
  const heightPx = raw.tiles !== null && typeof h === 'number' && Number.isFinite(h) ? Math.min(BOARD_MAX_PX, Math.max(BOARD_MIN_PX, Math.round(h))) : null;
  return { tiles: raw.tiles, panels, heightPx };
}
