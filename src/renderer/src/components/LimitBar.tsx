import { Show } from 'solid-js';
import type { LimitWindow } from '@shared/types';
import { shownPercent, trayIconText, trayLevel } from '@shared/trayValues';
import { now, settings } from '../store';
import { ResetTime } from './ui';

/** Bar width at 100% shown. */
const BAR_FULL = 100;

/** One limit column: label, percent, bar, reset caption (Theo's per-account cells). */
export function LimitBar(props: { window: LimitWindow }) {
  const t = () => settings().trayIcons;
  const used = () => props.window.usedPercent;
  const shown = () => shownPercent(used(), t().value);
  const shownValue = () => (shown() === null ? '—' : `${trayIconText(shown())}%`);
  const fill = () => Math.min(BAR_FULL, shown() ?? 0);
  const level = () => (props.window.status === 'rejected' ? 'critical' : trayLevel(used(), t().warnAtPercentUsed, t().criticalAtPercentUsed));
  return (
    <div class="limit" classList={{ empty: used() === null }} title={props.window.resetsAt ? new Date(props.window.resetsAt).toLocaleString() : undefined}>
      <div class="limit-head">
        <span class="truncate secondary">{props.window.label}</span>
        <span class="value">{shownValue()}</span>
      </div>
      <div class="limit-bar" classList={{ warn: level() === 'warn', critical: level() === 'critical' }}>
        <div style={{ width: `${fill()}%` }} />
      </div>
      <div class="limit-foot truncate">
        <Show when={props.window.resetsAt} fallback="No reset pending">{(r) => <ResetTime at={r()} now={now()} />}</Show>
      </div>
    </div>
  );
}
