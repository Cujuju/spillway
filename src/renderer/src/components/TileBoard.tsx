import { normalize, tileIds, TilingWorkspace, type Placing, type TileNode, type TileSize } from '@cujuju/solidjs-tiling-window-manager';
import { X } from 'lucide-solid';
import { createMemo, createSignal, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { appendRow } from '../lib/boardGrow';

/** CSS token for the gap between tiles (also the divider's grab area), shared with every other card gap. */
const TILE_GAP_TOKEN = '--card-gap';
/** Matches the header's title text, so the remove button doesn't set the header's height. */
const ICON_PX = 12;
/** Height asked for a tile added below the board: a header plus a readable chart. */
const NEW_ROW_PX = 320;

/** A saved board: a tile tree in the tiling package's shape, each tile's panel, and the height once resized. */
export interface BoardState<S> { tiles: unknown; panels: Record<string, S>; heightPx: number | null }
/** A panel waiting to be placed. */
export type PendingTile<S> = Placing & { spec: S };

export interface TileDef<S> {
  minSize: TileSize;
  /** The body reaches the tile's edges, like a full-width table. */
  bleed?: boolean;
  removeLabel?: string;
  /** Header content before the remove button. */
  createHead: (spec: () => S, id: string) => JSX.Element;
  /** Built once per tile; it reads `spec` inside its own JSX and memos. */
  createBody: (spec: () => S, id: string) => JSX.Element;
}

export interface TileBoardState<S> {
  layout: () => TileNode | undefined;
  panels: () => Record<string, S>;
  heightPx: () => number | null;
  save: (tiles: TileNode | undefined, added?: { id: string; spec: S }, height?: number | null) => Promise<void>;
}

/** A saved board whose edits show until the saved settings return, so a resize never snaps back. `pin` rewrites kept panels in tile order before saving. */
export function createTileBoard<S>(board: () => BoardState<S>, write: (next: BoardState<S>) => Promise<unknown>,
  pin?: (order: string[], panels: Record<string, S>) => Record<string, S>): TileBoardState<S> {
  const [pending, setPending] = createSignal<{ tiles: TileNode | undefined; panels: Record<string, S>; heightPx: number | null } | null>(null);
  const panels = () => pending()?.panels ?? board().panels;
  const heightPx = () => { const local = pending(); return local ? local.heightPx : board().heightPx; };
  const layout = createMemo(() => {
    const local = pending();
    return local ? local.tiles : normalize(board().tiles, new Set(Object.keys(board().panels)));
  });
  let saveRevision = 0;
  let saveQueue = Promise.resolve();
  /** Saves the tree and height and drops panels no longer in it, in one write. An emptied board fills the page again. */
  const save = (tiles: TileNode | undefined, added?: { id: string; spec: S }, height = heightPx()) => {
    const h = tiles ? height : null;
    const kept = new Set(tileIds(tiles));
    const filtered = Object.fromEntries(Object.entries(panels()).filter(([id]) => kept.has(id)));
    if (added) filtered[added.id] = added.spec;
    const next = pin ? pin(tileIds(tiles), filtered) : filtered;
    const revision = ++saveRevision;
    setPending({ tiles, panels: next, heightPx: h });
    saveQueue = saveQueue.then(() => write({ tiles: tiles ?? null, panels: next, heightPx: h })).then(() => undefined);
    return saveQueue.finally(() => { if (revision === saveRevision) setPending(null); });
  };
  return { layout, panels, heightPx, save };
}

/** Tiles filling the page: drag a header to move one, drag a gap to resize, place `placing` where clicked or below all. */
export function TileBoard<S extends { kind: string }>(props: {
  class: string; state: TileBoardState<S>; def: (kind: S['kind']) => TileDef<S>;
  /** Saving rebuilds every spec object; equal specs must not redraw the tile. */
  same: (a: S | undefined, b: S | undefined) => boolean;
  placing: PendingTile<S> | null; onPlacingEnd: () => void; empty: string; placeBelowLabel: string;
}) {
  let area: HTMLDivElement | undefined;
  /** The board's floor: the page's height below what sits above it, less the gap the bottom edge sits in. */
  const [floorPx, setFloorPx] = createSignal(0);
  onMount(() => {
    const measure = () => setFloorPx(Math.round(area!.clientHeight - tileGapPx));
    const observer = new ResizeObserver(measure);
    observer.observe(area!);
    measure();
    onCleanup(() => observer.disconnect());
  });
  const state = () => props.state;
  const specFor = (id: string) => state().panels()[id] ?? (props.placing?.id === id ? props.placing.spec : undefined);
  const minFor = (id: string): TileSize => { const spec = specFor(id); return spec ? props.def(spec.kind).minSize : { width: 0, height: 0 }; };
  const tileGapPx = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(TILE_GAP_TOKEN));
  if (!Number.isFinite(tileGapPx)) throw new Error(`${TILE_GAP_TOKEN} is not set in tokens.css`);
  const geometryOptions = () => ({ gapPx: tileGapPx, minSizes: new Map(tileIds(state().layout()).map((id) => [id, minFor(id)])) });

  /** Appends a full-width row below the others, which keep their pixels; the board grows by the new row. */
  const placeBelow = () => {
    const tile = props.placing;
    if (!tile) return;
    props.onPlacingEnd();
    // The workspace itself: the wrapper around it adds the bottom margin.
    const board = area!.querySelector(`.${props.class}`)!;
    const size = { width: board.clientWidth, height: board.getBoundingClientRect().height };
    const addPx = Math.max(NEW_ROW_PX, props.def(tile.spec.kind).minSize.height);
    void state().save(appendRow(state().layout(), tile.id, size, addPx, geometryOptions()), { id: tile.id, spec: tile.spec }, size.height + tileGapPx + addPx);
  };

  return (
    <div ref={area} class="board-area">
      <div class="board-stack">
        <TilingWorkspace
          class={props.class}
          layout={state().layout()}
          onLayoutChange={(next, height) => void state().save(next, undefined, height ?? state().heightPx())}
          // A divider resizes the tile above it and moves the rest; the bottom edge resizes the bottom tiles.
          verticalResize="push"
          heightPx={state().heightPx() ?? undefined}
          // Never shorter than the page: shrinking at the floor trades height with the bottom row.
          minHeightPx={floorPx()}
          gapPx={tileGapPx}
          minSize={minFor}
          // Tiles share the page's height; when their minimums need more, the board grows and the page scrolls.
          placement="reflow"
          growHeight
          placing={props.placing}
          onPlace={(id, next) => {
            const spec = props.placing?.spec;
            props.onPlacingEnd();
            if (spec) void state().save(next, { id, spec });
          }}
          onPlacingCancel={props.onPlacingEnd}
          empty={<div class="board-empty muted">{props.empty}</div>}
        >
          {(tile) => {
            const spec = createMemo(() => specFor(tile.id)!, undefined, { equals: props.same });
            // A tile id keeps its panel kind for life, so the body mounts once.
            const def = untrack(() => { const s = specFor(tile.id); return s ? props.def(s.kind) : null; });
            if (!def) return null;
            const head = def.createHead(spec, tile.id);
            const body = def.createBody(spec, tile.id);
            return (
              <Show when={specFor(tile.id)}>
                <section class="card board-tile" classList={{ bleed: def.bleed }}>
                  <header class="chart-head board-tile-head" onPointerDown={tile.startMove} title="Drag to move">
                    {head}
                    <span class="spacer" />
                    <button type="button" class="btn ghost icon-btn" title={def.removeLabel ?? 'Remove chart'} aria-label={def.removeLabel ?? 'Remove chart'} onClick={tile.remove}>
                      <X size={ICON_PX} />
                    </button>
                  </header>
                  <div class="board-tile-body">{body}</div>
                </section>
              </Show>
            );
          }}
        </TilingWorkspace>
        <Show when={props.placing && state().layout()}>
          <button type="button" class="board-place-below" onClick={placeBelow}>{props.placeBelowLabel}</button>
        </Show>
      </div>
    </div>
  );
}
