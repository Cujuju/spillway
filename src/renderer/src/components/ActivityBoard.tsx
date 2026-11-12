import { normalize, tileIds } from '@cujuju/solidjs-tiling-window-manager';
import { createMemo, Show } from 'solid-js';
import { Select } from './ui';
import { ACTIVITY_BOARD_VERSION, ACTIVITY_METRICS, type ActivityMetric, type ActivityPanelKind, type ActivityPanelSpec } from '@shared/activityBoard';
import { DEFAULT_COMBOS, MAX_COMBOS, type CompareReport } from '@shared/activityCompare';
import { baselineOf, comboName, comboTiles, pinCombos, resolveCombos, shownCombos } from '../lib/comboSelection';
import { settings, updateSettings } from '../store';
import { ADD_CHOICES, PANELS, type ActivityData, type ComboSelection } from './activityPanels';
import { createTileBoard, TileBoard, type PendingTile, type TileBoardState, type TileDef } from './TileBoard';

const sameSpec = (a: ActivityPanelSpec | undefined, b: ActivityPanelSpec | undefined) => a?.kind === b?.kind && a?.metric === b?.metric;

/** A chart waiting to be placed. */
export type PendingChart = PendingTile<ActivityPanelSpec>;

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
  const state: TileBoardState<ActivityPanelSpec> = createTileBoard<ActivityPanelSpec>(() => settings().activity.board,
    (b) => updateSettings((d) => { d.activity.board = { version: ACTIVITY_BOARD_VERSION, ...b }; }),
    (order, panels) => pinCombos(order, panels, resolved()));
  // Each card's combination follows the board order and the range's spend until pinned.
  const cards = createMemo(() => comboTiles(tileIds(state.layout()), state.panels()));
  const resolved = createMemo(() => resolveCombos(cards(), props.data.compare()?.combos.map((c) => c.key) ?? []));
  const shown = createMemo(() => shownCombos(cards(), resolved()));
  const selection: ComboSelection = {
    of: (id) => resolved().get(id) ?? null,
    shown,
    baseline: () => baselineOf(shown(), settings().activity.compareBaseline),
    setBaseline: (key) => void updateSettings((d) => { d.activity.compareBaseline = key; }),
  };
  const setMetric = (id: string, metric: ActivityMetric) =>
    updateSettings((d) => {
      const panel = d.activity.board.panels[id];
      if (panel) panel.metric = metric;
    });
  const def = (kind: ActivityPanelKind): TileDef<ActivityPanelSpec> => {
    const panel = PANELS[kind];
    return {
      minSize: panel.minSize, bleed: panel.bleed, removeLabel: panel.removeLabel,
      createHead: (spec, id) => {
        const ctx = { id, selection };
        return (
          <>
            <Show when={panel.switchesMetric} fallback={<div class="section-label" classList={{ quiet: panel.quiet }}>{panel.heading ? panel.heading(ctx) : panel.title(spec())}</div>}>
              <Select class="section-label title-switch" label="Chart metric" title="Change metric" value={spec().metric}
                options={ACTIVITY_METRICS.map((m) => ({ value: m, label: panel.title({ ...spec(), metric: m }) }))}
                onChange={(metric) => void setMetric(id, metric)} />
            </Show>
            <Show when={panel.info}>{(info) => info()()}</Show>
            <Show when={panel.note}>{(note) => <span class="chart-head-note">{note()(props.data, ctx)}</span>}</Show>
          </>
        );
      },
      createBody: (spec, id) => panel.createBody(spec, props.data, { id, selection }),
    };
  };

  return (
    <TileBoard class="activity-board" state={state} def={def} same={sameSpec} placing={props.placing} onPlacingEnd={props.onPlacingEnd}
      empty="No charts. Use “Add chart” to place one." placeBelowLabel="Place below all charts" />
  );
}
