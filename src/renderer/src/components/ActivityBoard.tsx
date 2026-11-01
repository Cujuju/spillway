import { normalize, tileIds, TilingWorkspace, type Placing, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
import { X } from 'lucide-solid';
import { createMemo, createSignal, For, Show, untrack } from 'solid-js';
import { ACTIVITY_METRICS, type ActivityMetric, type ActivityPanelSpec } from '@shared/activityBoard';
import { appendRow } from '../lib/boardGrow';
import { settings, updateSettings } from '../store';
import { ADD_CHOICES, PANELS, type ActivityData } from './activityPanels';

/** CSS token for the gap between tiles (also the divider's grab area), shared with every other card gap. */
const TILE_GAP_TOKEN = '--card-gap';
/** Matches the header's title text, so the remove button doesn't set the header's height. */
const ICON_PX = 12;
/** Height asked for a chart added below the board: a header plus a readable chart. */
const NEW_ROW_PX = 320;
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

/** The Overview's charts as tiles filling the page: drag a header to move one, drag a gap to resize, place `placing` where clicked. */
export function ActivityBoard(props: { data: ActivityData; placing: PendingChart | null; onPlacingEnd: () => void }) {
  // Shown from the moment of an edit until the saved settings come back, so a resize never snaps back.
  const [pending, setPending] = createSignal<{ tiles: TileNode | undefined; panels: Record<string, ActivityPanelSpec> } | null>(null);
  let area: HTMLDivElement | undefined;
  const board = () => settings().activity.board;
  const panels = () => pending()?.panels ?? board().panels;
  const layout = createMemo(() => {
    const local = pending();
    return local ? local.tiles : normalize(board().tiles, new Set(Object.keys(board().panels)));
  });
  const specFor = (id: string) => panels()[id] ?? (props.placing?.id === id ? props.placing.spec : undefined);
  const minFor = (id: string) => PANELS[specFor(id)?.kind ?? 'trend'].minSize;
  const tileGapPx = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(TILE_GAP_TOKEN));
  if (!Number.isFinite(tileGapPx)) throw new Error(`${TILE_GAP_TOKEN} is not set in tokens.css`);
  const geometryOptions = () => ({ gapPx: tileGapPx, minSizes: new Map(tileIds(layout()).map((id) => [id, minFor(id)])) });
  let saveRevision = 0;
  let saveQueue = Promise.resolve();

  /** Saves the tree and drops charts no longer in it, in one write. */
  const save = (tiles: TileNode | undefined, added?: { id: string; spec: ActivityPanelSpec }) => {
    const kept = new Set(tileIds(tiles));
    const next = Object.fromEntries(Object.entries(panels()).filter(([id]) => kept.has(id)));
    if (added) next[added.id] = added.spec;
    const revision = ++saveRevision;
    setPending({ tiles, panels: next });
    saveQueue = saveQueue.then(() => updateSettings((d) => { d.activity.board = { tiles: tiles ?? null, panels: next }; }));
    return saveQueue.finally(() => { if (revision === saveRevision) setPending(null); });
  };
  /** Appends a full-width row; the board keeps the page's height, so rows share it until their minimums make the page scroll. */
  const placeBelow = () => {
    const chart = props.placing;
    if (!chart) return;
    props.onPlacingEnd();
    const size = { width: area!.clientWidth, height: area!.firstElementChild!.getBoundingClientRect().height };
    const addPx = Math.max(NEW_ROW_PX, PANELS[chart.spec.kind].minSize.height);
    void save(appendRow(layout(), chart.id, size, addPx, geometryOptions()), { id: chart.id, spec: chart.spec });
  };
  const setMetric = (id: string, metric: ActivityMetric) =>
    updateSettings((d) => {
      const panel = d.activity.board.panels[id];
      if (panel) panel.metric = metric;
    });

  return (
    <div ref={area} class="board-area">
      <TilingWorkspace
        class="activity-board"
        layout={layout()}
        onLayoutChange={(next) => void save(next)}
        gapPx={tileGapPx}
        minSize={minFor}
        // Tiles share the page's height; when their minimums need more, the board grows and the page scrolls.
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
          return (
            <Show when={specFor(tile.id)}>
              <section class="card board-tile">
                <header class="chart-head board-tile-head" onPointerDown={tile.startMove} title="Drag to move">
                  <Show when={def.switchesMetric} fallback={<div class="section-label">{def.title(spec())}</div>}>
                    <select class="section-label title-switch" aria-label="Chart metric" title="Change metric"
                      onChange={(e) => {
                        const metric = ACTIVITY_METRICS.find((m) => m === e.currentTarget.value);
                        if (metric) void setMetric(tile.id, metric);
                      }}>
                      <For each={ACTIVITY_METRICS}>
                        {(m) => <option value={m} selected={m === spec().metric}>{def.title({ ...spec(), metric: m })}</option>}
                      </For>
                    </select>
                  </Show>
                  <Show when={def.note}>{(note) => <span class="chart-head-note">{note()(props.data)}</span>}</Show>
                  <span class="spacer" />
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
    </div>
  );
}
