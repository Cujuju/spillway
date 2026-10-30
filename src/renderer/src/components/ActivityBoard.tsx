import { normalize, tileIds, TilingWorkspace, type Placing, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
import { X } from 'lucide-solid';
import { createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { BOARD_MAX_PX, BOARD_MIN_PX, type ActivityPanelSpec } from '@shared/activityBoard';
import { appendRow } from '../lib/boardGrow';
import { settings, updateSettings } from '../store';
import { METRIC_OPTIONS } from './activityFormat';
import { ADD_CHOICES, PANELS, type ActivityData } from './activityPanels';
import { Seg } from './ui';

/** CSS token for the gap between tiles (also the divider's grab area), shared with every other card gap. */
const TILE_GAP_TOKEN = '--card-gap';
const ICON_PX = 14;
/** Room for title, note, the full metric switch, gaps and remove button. */
const FULL_HEADER_CONTROLS_PX = 560;
/** Height of a chart added below the board: a header plus a readable chart. */
const NEW_ROW_PX = 320;
/** Arrow keys on the resize handle move the board's bottom edge this far. */
const RESIZE_KEY_STEP_PX = 40;
/** Select value meaning "nothing picked", so the menu reads as a button. */
const NO_CHOICE = '';

/** A chart waiting to be placed. */
export type PendingChart = Placing & { spec: ActivityPanelSpec };

/** Picks a chart to add; placing it is the board's job. */
export function AddChartSelect(props: { onPick: (chart: PendingChart) => void }) {
  return (
    <select
      class="select"
      aria-label="Add chart"
      onChange={(e) => {
        const choice = ADD_CHOICES[Number(e.currentTarget.value)];
        e.currentTarget.value = NO_CHOICE;
        if (choice) props.onPick({ id: crypto.randomUUID(), label: choice.label, spec: choice.spec });
      }}
    >
      {/* `selected` here, not `value` on the select: the value is set before the options exist. */}
      <option value={NO_CHOICE} disabled selected>Add chart…</option>
      <For each={ADD_CHOICES}>{(choice, i) => <option value={i()}>{choice.label}</option>}</For>
    </select>
  );
}

/** The Overview's charts as tiles: drag a header to move one, drag a gap to resize, place `placing` where clicked. */
export function ActivityBoard(props: { data: ActivityData; placing: PendingChart | null; onPlacingEnd: () => void }) {
  // Shown from the moment of an edit until the saved settings come back, so a resize never snaps back.
  const [pending, setPending] = createSignal<{ tiles: TileNode | undefined; panels: Record<string, ActivityPanelSpec>; heightPx: number | null } | null>(null);
  /** Height while the resize handle is dragged, before it is saved. */
  const [dragPx, setDragPx] = createSignal<number | null>(null);
  let area: HTMLDivElement | undefined;
  const board = () => settings().activity.board;
  const panels = () => pending()?.panels ?? board().panels;
  const heightPx = () => dragPx() ?? (pending() ? pending()!.heightPx : board().heightPx);
  const clampPx = (px: number) => Math.min(BOARD_MAX_PX, Math.max(BOARD_MIN_PX, Math.round(px)));
  /** The board's current pixel height: saved, or measured while it fills the page. */
  const currentPx = () => heightPx() ?? area?.firstElementChild?.getBoundingClientRect().height ?? BOARD_MIN_PX;
  const layout = createMemo(() => {
    const local = pending();
    return local ? local.tiles : normalize(board().tiles, new Set(Object.keys(board().panels)));
  });
  const specFor = (id: string) => panels()[id] ?? (props.placing?.id === id ? props.placing.spec : undefined);
  const minFor = (id: string) => PANELS[specFor(id)?.kind ?? 'trend'].minSize;
  const tileGapPx = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(TILE_GAP_TOKEN));
  if (!Number.isFinite(tileGapPx)) throw new Error(`${TILE_GAP_TOKEN} is not set in tokens.css`);

  /** Saves the tree and drops charts no longer in it, in one write. */
  const save = (tiles: TileNode | undefined, added?: { id: string; spec: ActivityPanelSpec }, height = heightPx()) => {
    const kept = new Set(tileIds(tiles));
    const next = Object.fromEntries(Object.entries(panels()).filter(([id]) => kept.has(id)));
    if (added) next[added.id] = added.spec;
    // An emptied board goes back to filling the page.
    const h = tiles ? height : null;
    setPending({ tiles, panels: next, heightPx: h });
    return updateSettings((d) => { d.activity.board = { tiles: tiles ?? null, panels: next, heightPx: h }; }).finally(() => setPending(null));
  };
  const placeBelow = () => {
    const chart = props.placing;
    if (!chart) return;
    const boardPx = currentPx();
    props.onPlacingEnd();
    void save(appendRow(layout(), chart.id, boardPx, NEW_ROW_PX), { id: chart.id, spec: chart.spec }, clampPx(boardPx + NEW_ROW_PX + tileGapPx));
  };
  const startResize = (e: PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    // A one-time snapshot: the drag measures from where it began.
    const initialPx = currentPx();
    handle.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => setDragPx(clampPx(initialPx + m.clientY - startY));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      const px = dragPx();
      if (px !== null) void save(layout(), undefined, px).finally(() => setDragPx(null));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end, { once: true });
    handle.addEventListener('pointercancel', end, { once: true });
  };
  const resizeByKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? RESIZE_KEY_STEP_PX : e.key === 'ArrowUp' ? -RESIZE_KEY_STEP_PX : 0;
    if (!step) return;
    e.preventDefault();
    void save(layout(), undefined, clampPx(currentPx() + step));
  };
  const setMetric = (id: string, metric: ActivityPanelSpec['metric']) =>
    updateSettings((d) => {
      const panel = d.activity.board.panels[id];
      if (panel) panel.metric = metric;
    });

  return (
    <div ref={area} class="board-area" classList={{ sized: heightPx() !== null }}>
      <TilingWorkspace
        class="activity-board"
        style={heightPx() !== null ? { height: `${heightPx()}px` } : undefined}
        layout={layout()}
        onLayoutChange={(next) => void save(next)}
        gapPx={tileGapPx}
        minSize={minFor}
        // A full board still takes charts: neighbours give way, and the board grows taller; the page scrolls.
        placement="reflow"
        growHeight
        placing={props.placing}
        onPlace={(id, next) => {
          const spec = props.placing?.spec;
          props.onPlacingEnd();
          if (spec) void save(next, { id, spec });
        }}
        onPlacingCancel={props.onPlacingEnd}
        empty={<div class="board-empty muted">No charts. Use “Add chart” to place one.</div>}
      >
        {(tile) => {
          const spec = () => specFor(tile.id)!;
          // A tile id keeps its chart kind for life, so the body mounts once; only its metric changes.
          const def = PANELS[untrack(() => specFor(tile.id)?.kind) ?? 'trend'];
          const body = def.body(spec, props.data);
          const [compact, setCompact] = createSignal(false);
          const measureHeader = (header: HTMLElement) => {
            const observer = new ResizeObserver(([entry]) => setCompact(entry!.contentRect.width < FULL_HEADER_CONTROLS_PX));
            observer.observe(header);
            onCleanup(() => observer.disconnect());
          };
          return (
            <Show when={specFor(tile.id)}>
              <section class="card board-tile">
                <header ref={measureHeader} class="chart-head board-tile-head" onPointerDown={tile.startMove} title="Drag to move">
                  <div class="section-label">{def.title(spec())}</div>
                  <Show when={def.note}>{(note) => <span class="chart-head-note">{note()(props.data)}</span>}</Show>
                  <span class="spacer" />
                  <Show when={def.hasMetric}>
                    <Seg label="Chart metric" compact={compact()} value={spec().metric} options={METRIC_OPTIONS} onChange={(m) => void setMetric(tile.id, m)} />
                  </Show>
                  <button type="button" class="btn ghost icon-btn" title="Remove chart" aria-label="Remove chart" onClick={tile.remove}>
                    <X size={ICON_PX} />
                  </button>
                </header>
                <div class="board-tile-body">{body}</div>
              </section>
            </Show>
          );
        }}
      </TilingWorkspace>
      <Show when={props.placing && layout()}>
        <button type="button" class="board-place-below" onClick={placeBelow}>Place below all charts</button>
      </Show>
      <Show when={layout()}>
        <div class="board-resize" role="separator" aria-orientation="horizontal" aria-label="Resize chart area" tabindex="0"
          title="Drag to resize the chart area" onPointerDown={startResize} onKeyDown={resizeByKey} />
      </Show>
    </div>
  );
}
