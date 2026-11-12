/** Activity → Thinking's tiles: which panels exist and how they are tiled. */

export const THINKING_PANEL_KINDS = ['verdict', 'buckets', 'kinds', 'alternatives', 'method'] as const;
export type ThinkingPanelKind = (typeof THINKING_PANEL_KINDS)[number];

export interface ThinkingPanelSpec {
  kind: ThinkingPanelKind;
  /** A verdict's setting by spend: 0 is the costliest. */
  rank?: number;
}

/** Bumped when a release adds a panel every saved board should gain once. */
export const THINKING_BOARD_VERSION = 1;
/** Verdicts for the two costliest settings sit side by side. */
export const VERDICT_RANKS = [0, 1] as const;

export interface ThinkingBoard {
  version: number;
  /** Tile tree in @cujuju/solidjs-tiling-window-manager's shape; the renderer validates it. */
  tiles: unknown;
  panels: Record<string, ThinkingPanelSpec>;
  heightPx: number | null;
}

const tile = (id: string) => ({ kind: 'tile', id });
const split = (dir: 'row' | 'column', sizes: number[], ...children: unknown[]) => ({ kind: 'split', dir, sizes, children });
const verdictId = (rank: number) => `verdict-${rank + 1}`;

/** Verdicts, then where the thinking goes, kinds of turn, alternatives and the method note. Shares favour the tables. */
export const DEFAULT_THINKING_BOARD: ThinkingBoard = {
  version: THINKING_BOARD_VERSION,
  tiles: split('column', [1.1, 1.3, 1.1, 1.2, 0.45],
    split('row', VERDICT_RANKS.map(() => 1), ...VERDICT_RANKS.map((r) => tile(verdictId(r)))),
    tile('buckets'), tile('kinds'), tile('alternatives'), tile('method')),
  panels: {
    ...Object.fromEntries(VERDICT_RANKS.map((rank) => [verdictId(rank), { kind: 'verdict', rank }])),
    buckets: { kind: 'buckets' },
    kinds: { kind: 'kinds' },
    alternatives: { kind: 'alternatives' },
    method: { kind: 'method' },
  },
  heightPx: null,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isKind = (v: unknown): v is ThinkingPanelKind => typeof v === 'string' && (THINKING_PANEL_KINDS as readonly string[]).includes(v);

/** Keeps valid panels and a tree object (null when every panel was removed); anything else, or another version, is the default board. */
export function normalizeThinkingBoard(raw: unknown): ThinkingBoard {
  if (!isObj(raw) || raw.version !== THINKING_BOARD_VERSION || !isObj(raw.panels) || !(raw.tiles === null || isObj(raw.tiles))) return DEFAULT_THINKING_BOARD;
  const panels = Object.fromEntries(Object.entries(raw.panels).flatMap(([id, v]): [string, ThinkingPanelSpec][] =>
    id && isObj(v) && isKind(v.kind)
      ? [[id, { kind: v.kind, ...(v.kind === 'verdict' && Number.isSafeInteger(v.rank) && (v.rank as number) >= 0 ? { rank: v.rank as number } : {}) }]]
      : []));
  const heightPx = typeof raw.heightPx === 'number' && Number.isFinite(raw.heightPx) && raw.heightPx > 0 ? raw.heightPx : null;
  return { version: THINKING_BOARD_VERSION, tiles: raw.tiles, panels, heightPx };
}
