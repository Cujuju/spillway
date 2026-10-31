import { Show } from 'solid-js';
import { windowPace, type WindowPace } from '@shared/pace';
import type { LimitWindow } from '@shared/types';
import { shownPercent } from '@shared/trayValues';
import { compactDuration, pct, quotaPercent } from '../lib/format';
import { isExhausted, quotaColor } from '../lib/quotaColor';
import { now, settings } from '../store';
import { ResetTime } from './ui';

/** Bar width at 100% shown. */
const BAR_FULL = 100;

/** Chip badge colour per pace; a window that empties before reset is red whatever its state. */
const PACE_BADGE = { over: 'amber', on: '', under: 'green' } as const;
const RUNS_OUT_BADGE = 'red';

/** One limit column: label, pace chip, percent, bar with pace tick and forecast, reset caption with forecast on its right. */
export function LimitBar(props: { window: LimitWindow }) {
  const t = () => settings().trayIcons;
  const used = () => props.window.usedPercent;
  const shown = () => shownPercent(used(), t().value);
  const fill = () => Math.min(BAR_FULL, shown() ?? 0);
  const rejected = () => props.window.status === 'rejected';
  const pace = () => windowPace(props.window, now());
  return (
    <div class="limit" classList={{ empty: used() === null }} title={props.window.resetsAt ? new Date(props.window.resetsAt).toLocaleString() : undefined}>
      <div class="limit-head">
        <span class="truncate secondary">{props.window.label}</span>
        <span class="limit-figures">
          <Show when={pace()}>{(p) => <PaceChip pace={p()} />}</Show>
          <span class="value">{quotaPercent(shown())}</span>
        </span>
      </div>
      <div class="limit-bar">
        <div style={{ width: `${fill()}%`, background: quotaColor(used(), rejected()) }} />
        <Show when={pace()}>{(p) => <PaceMarks pace={p()} used={used()!} />}</Show>
      </div>
      <div class="limit-foot" classList={{ exhausted: isExhausted(used(), rejected()) }}>
        <Show when={props.window.resetsAt} fallback="No reset pending">{(r) => <ResetTime at={r()} now={now()} />}</Show>
        <Show when={pace()}>{(p) => <Forecast pace={p()} />}</Show>
      </div>
    </div>
  );
}

/** Signed gap to even pace in points; "On pace" inside the band. */
function PaceChip(props: { pace: WindowPace }) {
  const gap = () => Math.round(Math.abs(props.pace.deltaPercent));
  const tone = () => (props.pace.runsOutAt !== null ? RUNS_OUT_BADGE : PACE_BADGE[props.pace.state]);
  const title = () => `${props.pace.state === 'on' ? 'On even pace' : `${gap()} points ${props.pace.state} even pace`}: ${Math.round(props.pace.elapsedPercent)}% of the window has passed`;
  return (
    <span class={`badge pace-chip ${tone()}`} title={title()}>
      {props.pace.state === 'over' ? `▲ ${gap()}` : props.pace.state === 'under' ? `▼ ${gap()}` : 'On pace'}
    </span>
  );
}

/** Tick at even pace; striped span from now to the projected figure at reset. Both in the bar's shown unit. */
function PaceMarks(props: { pace: WindowPace; used: number }) {
  const unit = () => settings().trayIcons.value;
  const at = (usedPercent: number) => Math.min(BAR_FULL, shownPercent(usedPercent, unit()) ?? 0);
  const from = () => Math.min(at(props.used), at(props.pace.projectedPercent));
  const to = () => Math.max(at(props.used), at(props.pace.projectedPercent));
  return (
    <>
      <span class="pace-forecast" classList={{ 'runs-out': props.pace.runsOutAt !== null }} style={{ left: `${from()}%`, width: `${to() - from()}%` }} />
      <span class="pace-tick" style={{ left: `${at(props.pace.elapsedPercent)}%` }} />
    </>
  );
}

/** When the window runs out before reset, or where it ends, at the average rate so far. */
function Forecast(props: { pace: WindowPace }) {
  const unit = () => settings().trayIcons.value;
  const ends = () => `Ends near ${pct(shownPercent(props.pace.projectedPercent, unit()) ?? 0)} ${unit() === 'remaining' ? 'left' : 'used'}`;
  return (
    <div class="limit-forecast" classList={{ 'runs-out': props.pace.runsOutAt !== null }}>
      <Show when={props.pace.runsOutAt} fallback={ends()}>{(at) => `Runs out in ${compactDuration(at() - now())}`}</Show>
    </div>
  );
}
