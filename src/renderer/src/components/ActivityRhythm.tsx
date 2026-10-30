import { createMemo, For, Show } from 'solid-js';
import type { ActivityBucket } from '@shared/types';
import { metricValue, rhythmStats, type Metric, type Summary } from '../lib/activityStats';
import { compactNumber, pct } from '../lib/format';
import { costText } from './activityFormat';
import '../styles/rhythm.css';

export function ActivityRhythm(props: { rows: ActivityBucket[]; now: number; metric: Metric; format: (s: Summary) => string }) {
  const stats = createMemo(() => rhythmStats(props.rows, props.metric, props.now));
  const range = (band: { startHour: number; endHour: number }) => `${band.startHour}–${band.endHour}h`;
  const share = (value: number, total: number) => `${pct(total > 0 ? value / total * 100 : 0)} of total`;
  return (
    <div class="rhythm">
      <div class="rhythm-bands">
        <For each={stats().bands}>{(band) => (
          <div class="rhythm-band" classList={{ peak: stats().peak?.name === band.name }}>
            <span aria-hidden="true">{band.icon}</span>
            <span>{band.name}<small>{range(band)}</small></span>
            <div class="rhythm-bar"><span style={{ width: `${stats().max > 0 ? metricValue(band.summary, props.metric) / stats().max * 100 : 0}%` }} /></div>
            <strong>{props.format(band.summary)}</strong>
          </div>
        )}</For>
      </div>
      <div class="rhythm-footer">
        <span>Peak: <strong>{stats().peak?.name ?? '—'}</strong></span>
        <span title="Calendar span from the earliest stored hourly activity through today">{stats().days}d · {props.format(stats().total)} total</span>
      </div>
      <div class="rhythm-stats">
        <Show when={stats().peak} fallback={<div class="rhythm-empty muted">No peak for this metric</div>}>{(peak) => (
          <>
            <div><span>Tokens</span><strong>{compactNumber(peak().summary.totalTokens)}</strong><small>{share(peak().summary.totalTokens, stats().total.totalTokens)}</small></div>
            <div><span>Cost</span><strong>{costText(peak().summary)}</strong><small>{range(peak())}</small></div>
            <div><span>Requests</span><strong>{compactNumber(peak().summary.requests)}</strong><small>{share(peak().summary.requests, stats().total.requests)}</small></div>
          </>
        )}</Show>
      </div>
    </div>
  );
}
