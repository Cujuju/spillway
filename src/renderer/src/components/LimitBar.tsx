import type { LimitWindow } from '@shared/types';
import { trayLevel } from '@shared/trayValues';
import { resetText } from '@shared/resetTime';
import { now, settings } from '../store';

/** One limit column: label, percent, bar, reset caption (Theo's per-account cells). */
export function LimitBar(props: { window: LimitWindow }) {
  const t = () => settings().trayIcons;
  const used = () => props.window.usedPercent;
  const shownValue = () => {
    const u = used();
    if (u === null) return '—';
    return `${Math.round(t().value === 'remaining' ? Math.max(0, 100 - u) : u)}%`;
  };
  const fill = () => {
    const u = used();
    return u === null ? 0 : t().value === 'remaining' ? Math.max(0, 100 - u) : Math.min(100, u);
  };
  const level = () => (props.window.status === 'rejected' ? 'critical' : trayLevel(used(), t().warnAtPercentUsed, t().criticalAtPercentUsed));
  const caption = () => {
    const r = props.window.resetsAt;
    return r ? resetText(r, now()) : 'No reset pending';
  };
  return (
    <div class="limit" classList={{ empty: used() === null }} title={props.window.resetsAt ? new Date(props.window.resetsAt).toLocaleString() : undefined}>
      <div class="limit-head">
        <span class="truncate secondary">{props.window.label}</span>
        <span class="value">{shownValue()}</span>
      </div>
      <div class="limit-bar" classList={{ warn: level() === 'warn', critical: level() === 'critical' }}>
        <div style={{ width: `${fill()}%` }} />
      </div>
      <div class="limit-foot truncate">{caption()}</div>
    </div>
  );
}
