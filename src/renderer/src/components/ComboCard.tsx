import { Show } from 'solid-js';
import type { CompareReport } from '@shared/activityCompare';
import { comboRow } from '../lib/comboSelection';
import { money, spanText } from '../lib/compareFormat';
import { usd } from '../lib/format';

/** One combination: median cost per task in kept requests, a ledger from its tasks' cost to its own spend, then whole-range spend. */
export function ComboCard(props: { report: CompareReport; combo: string }) {
  const row = () => comboRow(props.report, props.combo);
  const tasks = () => row().tasks;
  const covered = () => (tasks()?.costUsd ?? 0) - (tasks()?.otherCostUsd ?? 0) + row().asSubagentCostUsd;
  const kept = () => (props.report.retained ? spanText(props.report.retained) : 'kept requests');
  return (
    <>
      <div class="combo-lead">
        <span class="combo-lead-v">{tasks() ? usd(tasks()!.medianCostUsd) : '—'}</span>
        <span class="combo-lead-l">median cost per task</span>
      </div>
      <div class="combo-lead-sub">
        <Show when={tasks()} fallback="No task started here in the kept requests">
          {(t) => <>mean {usd(t().meanCostUsd)} · 90th percentile {usd(t().p90CostUsd)}</>}
        </Show>
      </div>
      <dl class="combo-ledger">
        <dt>Tasks started here · {(tasks()?.tasks ?? 0).toLocaleString()}</dt><dd>{usd(tasks()?.costUsd ?? 0)}</dd>
        <dt>Other models inside them · {(tasks()?.mixed ?? 0).toLocaleString()} mixed</dt><dd>{money(-(tasks()?.otherCostUsd ?? 0))}</dd>
        <dt>As subagents in other tasks</dt><dd>+ {money(row().asSubagentCostUsd)}</dd>
        <dt class="sum">Spent here, {kept()}</dt><dd class="sum">{money(covered())}</dd>
        <dt>Spent here, whole range</dt><dd>{usd(row().whole.costUsd)}</dd>
      </dl>
    </>
  );
}
