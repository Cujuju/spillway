import { createMemo, For, Show, type JSX } from 'solid-js';
import { settingKey, type SettingReport, type ThinkingReport } from '@shared/thinking';
import { THINKING_BOARD_VERSION, VERDICT_RANKS, type ThinkingPanelKind, type ThinkingPanelSpec } from '@shared/thinkingBoard';
import { usd } from '../lib/format';
import { spanText } from '../lib/compareFormat';
import { chosenSetting, perWeek, settingName } from '../lib/thinkingReport';
import { settings, updateSettings } from '../store';
import { Select } from './ui';
import { createTileBoard, TileBoard, type PendingTile, type TileDef } from './TileBoard';
import { AlternativesTable, KindsTable, ThinkingMethod, ThinkingMix, Verdict } from './ThinkingPanels';

/** Tile chrome (padding, border, header) is 52px; each minimum adds the body that must show without scrolling. */
/** A verdict: two-line sentence, two savings and the status line. */
const VERDICT_MIN = { width: 320, height: 230 };
/** Two settings side by side: name, sentence, two bars and a three-row bucket table. */
const MIX_MIN = { width: 420, height: 340 };
/** Three kinds, the footer and the two-line recommendation. */
const KINDS_MIN = { width: 480, height: 380 };
/** The current setting and four alternatives; more scroll. */
const ALTS_MIN = { width: 480, height: 300 };
/** Five one- or two-line bullets. */
const METHOD_MIN = { width: 320, height: 170 };
/** "Where the thinking goes" shows the costliest settings, as many as the verdicts. */
const MIX_SETTINGS = VERDICT_RANKS.length;

export type PendingThinkingTile = PendingTile<ThinkingPanelSpec>;
const sameSpec = (a: ThinkingPanelSpec | undefined, b: ThinkingPanelSpec | undefined) => a?.kind === b?.kind && a?.rank === b?.rank;
const series = (rank: number) => `series-${rank + 1}`;

/** Panels a user can add back once removed. */
const ADD_CHOICES: { label: string; spec: ThinkingPanelSpec }[] = [
  ...VERDICT_RANKS.map((rank) => ({ label: rank === 0 ? 'Verdict · costliest setting' : `Verdict · setting ${rank + 1}`, spec: { kind: 'verdict' as const, rank } })),
  { label: 'Where the thinking goes', spec: { kind: 'buckets' } },
  { label: 'By kind of turn', spec: { kind: 'kinds' } },
  { label: 'Alternatives', spec: { kind: 'alternatives' } },
  { label: 'How this is worked out', spec: { kind: 'method' } },
];

export function AddThinkingSelect(props: { onPick: (tile: PendingThinkingTile) => void }) {
  return (
    <Select label="Add panel" placeholder="Add panel…" options={ADD_CHOICES.map((c, i) => ({ value: i, label: c.label }))}
      onChange={(i) => { const choice = ADD_CHOICES[i]; if (choice) props.onPick({ id: crypto.randomUUID(), label: choice.label, spec: choice.spec }); }} />
  );
}

/** Which days the report covers, for the scope row. */
export function ThinkingCoverage(props: { report: ThinkingReport | null | undefined }) {
  return (
    <Show when={props.report?.coveredFrom ? props.report : undefined}>
      {(r) => <span class="muted think-cover">Turns from {spanText({ from: r().coveredFrom!, to: r().coveredTo! })} · {r().coveredDays} days</span>}
    </Show>
  );
}

/** The setting picker in a tile title: By kind of turn and Alternatives follow the same choice. */
function SettingTitle(props: { report: ThinkingReport | null | undefined; prefix: string }) {
  const current = () => (props.report ? chosenSetting(props.report, settings().activity.thinkingSetting) : undefined);
  const rank = () => props.report?.settings.findIndex((s) => s === current()) ?? -1;
  return (
    <Show when={current()} fallback={<div class="section-label">{props.prefix}</div>}>
      {(s) => (
        <span class={`think-title ${rank() >= 0 && rank() < MIX_SETTINGS ? series(rank()) : ''}`}>
          <Show when={rank() >= 0 && rank() < MIX_SETTINGS}><span class="swatch" /></Show>
          <Select class="section-label title-switch" label="Setting" title="Change setting" value={settingKey(s().setting)}
            options={props.report!.settings.map((x) => ({ value: settingKey(x.setting), label: `${props.prefix} · ${settingName(x.setting)}` }))}
            onChange={(key) => void updateSettings((d) => { d.activity.thinkingSetting = key; })} />
        </span>
      )}
    </Show>
  );
}

/** Thinking's panels as tiles: verdicts for the costliest settings, where the thinking goes, kinds of turn, alternatives and the method. */
export function ThinkingView(props: { report: ThinkingReport | null | undefined; placing: PendingThinkingTile | null; onPlacingEnd: () => void }) {
  const state = createTileBoard<ThinkingPanelSpec>(() => settings().activity.thinkingBoard,
    (b) => updateSettings((d) => { d.activity.thinkingBoard = { version: THINKING_BOARD_VERSION, ...b }; }));
  const chosen = createMemo(() => (props.report ? chosenSetting(props.report, settings().activity.thinkingSetting) : undefined));
  const ready = (body: (r: ThinkingReport) => JSX.Element) => (
    <Show when={props.report && props.report.settings.length > 0 ? props.report : undefined} fallback={<div class="muted">{props.report === undefined ? 'Loading…' : 'No turns in this range yet.'}</div>}>
      {(r) => body(r())}
    </Show>
  );
  const withSetting = (body: (r: ThinkingReport, s: SettingReport) => JSX.Element) => ready((r) => <Show when={chosen()}>{(s) => body(r, s())}</Show>);
  const rankOf = (spec: () => ThinkingPanelSpec) => spec().rank ?? 0;
  const at = (spec: () => ThinkingPanelSpec) => props.report?.settings[rankOf(spec)];

  const DEFS: Record<ThinkingPanelKind, TileDef<ThinkingPanelSpec>> = {
    verdict: {
      minSize: VERDICT_MIN, removeLabel: 'Remove verdict',
      createHead: (spec) => (
        <>
          <div class="section-label"><Show when={at(spec)} fallback={`Setting ${rankOf(spec) + 1}`}>
            {(s) => <span class={`think-title ${series(rankOf(spec))}`}><span class="swatch" />{settingName(s().setting)}</span>}
          </Show></div>
          <Show when={at(spec) && props.report}>{(r) => <span class="chart-head-note num">{usd(at(spec)!.costUsdPerWeek, 0)} a week · {Math.round(perWeek(r(), at(spec)!.turns)).toLocaleString()} turns</span>}</Show>
        </>
      ),
      createBody: (spec) => ready(() => <Show when={at(spec)} fallback={<div class="muted">No other setting in this range.</div>}>{(s) => <Verdict s={s()} />}</Show>),
    },
    buckets: {
      minSize: MIX_MIN,
      createHead: () => <><div class="section-label">Where the thinking goes</div><span class="chart-head-note">Thinking per turn. Light: under 2K tokens. Typical: 2K to 20K. Heavy: over 20K.</span></>,
      createBody: () => ready((r) => (
        <div class="think-mixes">
          <For each={r.settings.slice(0, MIX_SETTINGS)}>{(s, i) => <ThinkingMix report={r} s={s} series={series(i())} />}</For>
        </div>
      )),
    },
    kinds: {
      minSize: KINDS_MIN,
      createHead: () => <><SettingTitle report={props.report} prefix="By kind of turn" /><span class="chart-head-note">Sorted by what a turn looks like, not by what you asked.</span></>,
      createBody: () => withSetting((r, s) => <KindsTable report={r} s={s} />),
    },
    alternatives: {
      minSize: ALTS_MIN, bleed: true,
      createHead: () => <><SettingTitle report={props.report} prefix="Alternatives" /><span class="chart-head-note">Every cost and saving here is an estimate.</span></>,
      createBody: () => withSetting((_r, s) => <AlternativesTable s={s} />),
    },
    method: {
      minSize: METHOD_MIN,
      createHead: () => <div class="section-label quiet">How this is worked out</div>,
      createBody: () => <ThinkingMethod />,
    },
  };

  return (
    <>
      <p class="think-est">
        Costs are estimates at API list prices. On a subscription, read them as how fast you use your limits.
        <Show when={props.report?.untracked.requests}>
          {' '}Not counted: {props.report!.untracked.requests.toLocaleString()} requests ({usd(props.report!.untracked.costUsd)}) with no recorded effort or from before turns were recorded.
        </Show>
      </p>
      <TileBoard class="activity-board" state={state} def={(kind) => DEFS[kind]} same={sameSpec} placing={props.placing} onPlacingEnd={props.onPlacingEnd}
        empty="No panels. Use “Add panel” to place one." placeBelowLabel="Place below all panels" />
    </>
  );
}
