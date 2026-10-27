import { Show } from 'solid-js';
import type { LimitWindow } from '@shared/types';
import { shownPercent, trayIconText } from '@shared/trayValues';
import { isExhausted, quotaColor } from '../lib/quotaColor';
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
  const rejected = () => props.window.status === 'rejected';
  return (
    <div class="limit" classList={{ empty: used() === null }} title={props.window.resetsAt ? new Date(props.window.resetsAt).toLocaleString() : undefined}>
      <div class="limit-head">
        <span class="truncate secondary">{props.window.label}</span>
        <span class="value">{shownValue()}</span>
      </div>
      <div class="limit-bar">
        <div style={{ width: `${fill()}%`, background: quotaColor(used(), rejected()) }} />
      </div>
      <div class="limit-foot" classList={{ exhausted: isExhausted(used(), rejected()) }}>
        <Show when={props.window.resetsAt} fallback="No reset pending">{(r) => <ResetTime at={r()} now={now()} />}</Show>
      </div>
    </div>
  );
}
