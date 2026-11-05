import { createMemo, For } from 'solid-js';
import type { ActivityBucket } from '@shared/types';
import { byModelEffort, timingMean } from '../lib/activityStats';
import { compactNumber } from '../lib/format';
import { costText } from './activityFormat';
import { ProviderGlyph } from './ui';

const mean = (sum: number, count: number) => {
  const ms = timingMean(sum, count);
  return ms === null ? '—' : `${(ms / 1000).toFixed(2)} s`;
};

/** Uses the overview's exact range and filters, with durable sums rather than means of hourly means. */
export function ActivityEfforts(props: { rows: ActivityBucket[] }) {
  const rows = createMemo(() => byModelEffort(props.rows));
  return (
    <div class="card table-card">
      <div class="card-head"><h3>Model and effort</h3></div>
      <p class="muted">Selected time frame and filters. Timings use measured successful proxy attempts only; sample counts appear below each mean. Historical and local-log effort stays unknown.</p>
      <table class="table dense">
        <thead><tr><th>Effective model</th><th>Effort</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">API cost</th><th class="num">Mean first token</th><th class="num">Mean total time</th></tr></thead>
        <tbody>
          <For each={rows()} fallback={<tr><td colSpan={10} class="muted">No requests match this range and filters.</td></tr>}>
            {(r) => <tr>
              <td><div class="cell-name"><ProviderGlyph provider={r.provider} size="sm" /><span>{r.model || 'Unknown'}{!r.effectiveKnown && <span class="muted"> (requested; effective unknown)</span>}</span></div></td>
              <td>{r.effort ?? 'Unknown'}</td>
              <td class="tabular num">{r.summary.requests.toLocaleString()}<div class="muted">{r.summary.failed.toLocaleString()} failed</div></td>
              <td class="tabular num">{compactNumber(r.summary.inputTokens)}</td>
              <td class="tabular num">{compactNumber(r.summary.outputTokens)}</td>
              <td class="tabular num">{compactNumber(r.summary.cachedTokens)}</td>
              <td class="tabular num">{compactNumber(r.summary.cacheWriteTokens)}</td>
              <td class="tabular num" title={`${r.summary.unpricedRequests} unpriced requests excluded`}>{costText(r.summary)}</td>
              <td class="tabular num">{mean(r.summary.ttftSumMs, r.summary.ttftCount)}<div class="muted">n={r.summary.ttftCount.toLocaleString()}</div></td>
              <td class="tabular num">{mean(r.summary.latencySumMs, r.summary.latencyCount)}<div class="muted">n={r.summary.latencyCount.toLocaleString()}</div></td>
            </tr>}
          </For>
        </tbody>
      </table>
    </div>
  );
}
