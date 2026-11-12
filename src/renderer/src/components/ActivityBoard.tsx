import { normalize, tileIds, TilingWorkspace, type Placing, type TileNode } from '@cujuju/solidjs-tiling-window-manager';
import { X } from 'lucide-solid';
import { createMemo, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js';
import { Select } from './ui';
import { ACTIVITY_BOARD_VERSION, ACTIVITY_METRICS, type ActivityMetric, type ActivityPanelSpec } from '@shared/activityBoard';
import { DEFAULT_COMBOS, MAX_COMBOS, type CompareReport } from '@shared/activityCompare';
import { appendRow } from '../lib/boardGrow';
import { baselineOf, comboName, comboTiles, pinCombos, resolveCombos, shownCombos } from '../lib/comboSelection';
import { settings, updateSettings } from '../store';
import { ADD_CHOICES, PANELS, type ActivityData, type ComboSelection } from './activityPanels';

/** CSS token for the gap between tiles (also the divider's grab area), shared with every other card gap. */
const TILE_GAP_TOKEN = '--card-gap';
/** Matches the header's title text, so the remove button doesn't set the header's height. */
const ICON_PX = 12;
/** Height asked for a chart added below the board: a header plus a readable chart. */
const NEW_ROW_PX = 320;
const sameSpec = (a: ActivityPanelSpec | undefined, b: ActivityPanelSpec | undefined) => a?.kind === b?.kind && a?.metric === b?.metric;

/** A chart waiting to be placed. */
export type PendingChart = Placing & { spec: ActivityPanelSpec };

/** Picks a chart to add; placing it is the board's job. */
export function AddChartSelect(props: { onPick: (chart: PendingChart) => void }) {
  return (
    <Select label="Add chart" placeholder="Add chart…" options={ADD_CHOICES.map((c, i) => ({ value: i, label: c.label }))}
      onChange={(i) => { const choice = ADD_CHOICES[i]; if (choice) props.onPick({ id: crypto.randomUUID(), label: choice.label, spec: choice.spec }); }} />
  );
}

/** "3 of 4 combinations" and a menu adding a card for a combination not shown; placing it is the board's job. */
export function AddComboSelect(props: { report: CompareReport | null | undefined; onPick: (chart: PendingChart) => void }) {
  const board = () => settings().activity.board;
  const cards = createMemo(() => comboTiles(tileIds(normalize(board().tiles, new Set(Object.keys(board().panels)))), board().panels));
  const ranked = () => props.report?.combos.map((c) => c.key) ?? [];
  const options = createMemo(() => {
    const shown = new Set(shownCombos(cards(), resolveCombos(cards(), ranked())));
    return ranked().filter((key) => !shown.has(key)).map((key) => ({ value: key, label: comboName(key) }));
  });
  return (
    <>
      <span class="muted combo-count">{cards().length} of {MAX_COMBOS} combinations</span>
      <Select label="Add combination" placeholder="Add combination…" options={options()} disabled={cards().length >= MAX_COMBOS || options().length === 0}
        title={`Model and effort. Starts with the top ${DEFAULT_COMBOS} by cost in the range, then keeps your last selection.`}
        onChange={(key) => props.onPick({ id: crypto.randomUUID(), label: comboName(key), spec: { kind: 'combo', metric: 'cost', combo: key } })} />
    </>
  );
}

/** The Overview's charts as tiles filling the page: drag a header to move one, drag a gap to resize, place `placing` where clicked. */
export function ActivityBoard(props: { data: ActivityData; placing: PendingChart | null; onPlacingEnd: () => void }) {
  // Shown from the moment of an edit until the saved settings come back, so a resize never snaps back.
  const [pending, setPending] = createSignal<{ tiles: TileNode | undefined; panels: Record<string, ActivityPanelSpec>; heightPx: number | null } | null>(null);
  let area: HTMLDivElement | undefined;
  /** The board's floor: the page's height below the stat strip, less the gap the bottom edge sits in. */
  const [floorPx, setFloorPx] = createSignal(0);
  onMount(() => {
    const measure = () => setFloorPx(Math.round(area!.clientHeight - tileGapPx));
    const observer = new ResizeObserver(measure);
    observer.observe(area!);
    measure();
    onCleanup(() => observer.disconnect());
  });
  const board = () => settings().activity.board;
  const panels = () => pending()?.panels ?? board().panels;
  const heightPx = () => { const local = pending(); return local ? local.heightPx : board().heightPx; };
  const layout = createMemo(() => {
    const local = pending();
    return local ? local.tiles : normalize(board().tiles, new Set(Object.keys(board().panels)));
  });
  // Each card's combination follows the board order and the range's spend until pinned.
  const cards = createMemo(() => comboTiles(tileIds(layout()), panels()));
  const resolved = createMemo(() => resolveCombos(cards(), props.data.compare()?.combos.map((c) => c.key) ?? []));
  const shown = createMemo(() => shownCombos(cards(), resolved()));
  const selection: ComboSelection = {
    of: (id) => resolved().get(id) ?? null,
    shown,
    baseline: () => baselineOf(shown(), settings().activity.compareBaseline),
    setBaseline: (key) => void updateSettings((d) => { d.activity.compareBaseline = key; }),
  };
  const specFor = (id: string) => panels()[id] ?? (props.placing?.id === id ? props.placing.spec : undefined);
  const minFor = (id: string) => PANELS[specFor(id)?.kind ?? 'trend'].minSize;
  const tileGapPx = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(TILE_GAP_TOKEN));
  if (!Number.isFinite(tileGapPx)) throw new Error(`${TILE_GAP_TOKEN} is not set in tokens.css`);
  const geometryOptions = () => ({ gapPx: tileGapPx, minSizes: new Map(tileIds(layout()).map((id) => [id, minFor(id)])) });
  let saveRevision = 0;
  let saveQueue = Promise.resolve();

  /** Saves the tree and height and drops charts no longer in it, in one write. An emptied board fills the page again. */
  const save = (tiles: TileNode | undefined, added?: { id: string; spec: ActivityPanelSpec }, height = heightPx()) => {
    const h = tiles ? height : null;
    const kept = new Set(tileIds(tiles));
    const filtered = Object.fromEntries(Object.entries(panels()).filter(([id]) => kept.has(id)));
    if (added) filtered[added.id] = added.spec;
    const next = pinCombos(tileIds(tiles), filtered, resolved());
    const revision = ++saveRevision;
    setPending({ tiles, panels: next, heightPx: h });
    saveQueue = saveQueue.then(() => updateSettings((d) => { d.activity.board = { version: ACTIVITY_BOARD_VERSION, tiles: tiles ?? null, panels: next, heightPx: h }; }));
    return saveQueue.finally(() => { if (revision === saveRevision) setPending(null); });
  };
  /** Appends a full-width row below the others, which keep their pixels; the board grows by the new row. */
  const placeBelow = () => {
    const chart = props.placing;
    if (!chart) return;
    props.onPlacingEnd();
    // The workspace itself: the wrapper around it adds the bottom margin.
    const board = area!.querySelector('.activity-board')!;
    const size = { width: board.clientWidth, height: board.getBoundingClientRect().height };
    const addPx = Math.max(NEW_ROW_PX, PANELS[chart.spec.kind].minSize.height);
    void save(appendRow(layout(), chart.id, size, addPx, geometryOptions()), { id: chart.id, spec: chart.spec }, size.height + tileGapPx + addPx);
  };
  const setMetric = (id: string, metric: ActivityMetric) =>
    updateSettings((d) => {
      const panel = d.activity.board.panels[id];
      if (panel) panel.metric = metric;
    });

  return (
    <div ref={area} class="board-area">
      <div class="board-stack">
        <TilingWorkspace
          class="activity-board"
          layout={layout()}
          onLayoutChange={(next, height) => void save(next, undefined, height ?? heightPx())}
          // A divider resizes the tile above it and moves the rest; the bottom edge resizes the bottom tiles.
          verticalResize="push"
          heightPx={heightPx() ?? undefined}
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
            if (spec) void save(next, { id, spec });
          }}
          onPlacingCancel={props.onPlacingEnd}
          empty={<div class="board-empty muted">No charts. Use “Add chart” to place one.</div>}
        >
          {(tile) => {
            // Saving the layout rebuilds every spec object; equal specs must not redraw the chart.
            const spec = createMemo(() => specFor(tile.id)!, undefined, { equals: sameSpec });
            // A tile id keeps its chart kind for life, so the body mounts once; only its metric changes.
            const def = PANELS[untrack(() => specFor(tile.id)?.kind) ?? 'trend'];
            const ctx = { id: tile.id, selection };
            const body = def.createBody(spec, props.data, ctx);
            return (
              <Show when={specFor(tile.id)}>
                <section class="card board-tile" classList={{ bleed: def.bleed }}>
                  <header class="chart-head board-tile-head" onPointerDown={tile.startMove} title="Drag to move">
                    <Show when={def.switchesMetric} fallback={<div class="section-label" classList={{ quiet: def.quiet }}>{def.heading ? def.heading(ctx) : def.title(spec())}</div>}>
                      <Select class="section-label title-switch" label="Chart metric" title="Change metric" value={spec().metric}
                        options={ACTIVITY_METRICS.map((m) => ({ value: m, label: def.title({ ...spec(), metric: m }) }))}
                        onChange={(metric) => void setMetric(tile.id, metric)} />
                    </Show>
                    <Show when={def.info}>{(info) => info()()}</Show>
                    <Show when={def.note}>{(note) => <span class="chart-head-note">{note()(props.data, ctx)}</span>}</Show>
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
        <Show when={props.placing && layout()}>
          <button type="button" class="board-place-below" onClick={placeBelow}>Place below all charts</button>
        </Show>
      </div>
    </div>
  );
}
