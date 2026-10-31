import { Lock } from 'lucide-solid';
import { Show } from 'solid-js';
import { windowPace, type WindowPace } from '@shared/pace';
import type { LimitWindow } from '@shared/types';
import { shownPercent } from '@shared/trayValues';
import { compactDuration, dateTime, pct, quotaPercent } from '../lib/format';
import type { AccountForecast } from '../lib/forecast';
import { isExhausted, quotaColor } from '../lib/quotaColor';
import { now, settings } from '../store';
import { HoverTip } from './ChartTip';
import { ResetTime } from './ui';

/** Bar width at 100% shown. */
const BAR_FULL = 100;

/** Chip badge colour per pace; a window forecast to run out before reset is red whatever its pace. */
const PACE_BADGE = { over: 'amber', on: '', under: 'green' } as const;
const RUNS_OUT_BADGE = 'red';

/** One limit column: pace chip, percent, bar with tick and forecast, reset caption. `forecast` comes from the pool projection, so it matches the card. */
export function LimitBar(props: { window: LimitWindow; forecast: AccountForecast | null }) {
  const unit = () => settings().trayIcons.value;
  const used = () => props.window.usedPercent;
  const shown = () => shownPercent(used(), unit());
  /** Bar position of a used percent, in the bar's shown unit. */
  const at = (usedPercent: number) => Math.min(BAR_FULL, shownPercent(usedPercent, unit()) ?? 0);
  const rejected = () => props.window.status === 'rejected';
  const pace = () => windowPace(props.window, now());
  const runsOut = () => props.forecast?.runsOutAt != null;
  return (
    <div class="limit" classList={{ empty: used() === null }} title={props.window.resetsAt ? new Date(props.window.resetsAt).toLocaleString() : undefined}>
      <div class="limit-head">
        <span class="truncate secondary">{props.window.label}</span>
        <span class="limit-figures">
          <Show when={pace()}>{(p) => <PaceChip pace={p()} runsOut={runsOut()} />}</Show>
          <span class="value">{quotaPercent(shown())}</span>
        </span>
      </div>
      <div class="limit-bar">
        <div style={{ width: `${Math.min(BAR_FULL, shown() ?? 0)}%`, background: quotaColor(used(), rejected()) }} />
        <Show when={used() !== null && props.forecast}>
          {(f) => {
            const from = () => Math.min(at(used()!), at(f().endsAtPercent));
            const to = () => Math.max(at(used()!), at(f().endsAtPercent));
            return <span class="pace-forecast" classList={{ 'runs-out': runsOut() }} style={{ left: `${from()}%`, width: `${to() - from()}%` }} />;
          }}
        </Show>
        <Show when={pace()}>{(p) => <span class="pace-tick" style={{ left: `${at(p().elapsedPercent)}%` }} />}</Show>
      </div>
      <div class="limit-foot" classList={{ exhausted: isExhausted(used(), rejected()) }}>
        <Show when={props.window.resetsAt} fallback="No reset pending">{(r) => <ResetTime at={r()} now={now()} />}</Show>
        <Show when={!isExhausted(used(), rejected()) && props.forecast}>{(f) => <Forecast forecast={f()} resetsAt={props.window.resetsAt} />}</Show>
      </div>
    </div>
  );
}

/** Signed gap to even pace in points; "On pace" inside the band. */
function PaceChip(props: { pace: WindowPace; runsOut: boolean }) {
  const gap = () => Math.round(Math.abs(props.pace.deltaPercent));
  const tone = () => (props.runsOut ? RUNS_OUT_BADGE : PACE_BADGE[props.pace.state]);
  const title = () => (props.pace.state === 'on' ? 'On pace' : `${gap()} points ${props.pace.state} pace`);
  const rows = () => [
    { label: 'Used', value: `${Math.round(props.pace.elapsedPercent + props.pace.deltaPercent)}%` },
    { label: 'Time passed', value: `${Math.round(props.pace.elapsedPercent)}%` },
  ];
  return (
    <HoverTip title={title()} rows={rows()}>
      {/* Empty title keeps the cell's reset-date title from also showing. */}
      <span class={`badge compact ${tone()}`} title="">
        {props.pace.state === 'over' ? `▲ ${gap()}` : props.pace.state === 'under' ? `▼ ${gap()}` : 'On pace'}
      </span>
    </HoverTip>
  );
}

/** Where the window ends at the forecast rate, or, when it runs out first, the time stuck before its reset. */
function Forecast(props: { forecast: AccountForecast; resetsAt: string | null }) {
  const unit = () => settings().trayIcons.value;
  const endsAt = () => `${pct(shownPercent(props.forecast.endsAtPercent, unit()) ?? 0)} ${unit() === 'remaining' ? 'left' : 'used'}`;
  /** Time between running out and the reset; runsOutAt is only set before a known reset. */
  const deficit = (out: number) => (props.resetsAt ? compactDuration(Date.parse(props.resetsAt) - out) : null);
  const title = () => {
    const out = props.forecast.runsOutAt;
    if (out === null) return `Ends near ${endsAt()}`;
    return deficit(out) ? `Locked out ${deficit(out)} before reset` : 'Runs out';
  };
  const rows = () => {
    const out = props.forecast.runsOutAt;
    const reset = props.resetsAt ? [{ label: 'Resets', value: dateTime(props.resetsAt) }] : [];
    if (out === null) return reset;
    return [{ label: 'Runs out', value: dateTime(out) }, { label: 'Runs out in', value: compactDuration(out - now()) }, ...reset];
  };
  return (
    <HoverTip title={title()} rows={rows()}>
      {/* Empty title keeps the cell's reset-date title from also showing. */}
      <div class="limit-forecast" classList={{ 'runs-out': props.forecast.runsOutAt !== null }} title="">
        <Show when={props.forecast.runsOutAt} fallback={`Ends ~${endsAt()}`}>
          {(out) => (
            <span class="reset-time">
              <Lock size="1em" role="img" aria-label="Locked out before reset for" />
              {/* A window not yet started has no reset to measure against; show when it runs out instead. */}
              {deficit(out()) ?? `in ${compactDuration(out() - now())}`}
            </span>
          )}
        </Show>
      </div>
    </HoverTip>
  );
}
