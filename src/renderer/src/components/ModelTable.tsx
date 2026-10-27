import { For } from 'solid-js';
import { metricValue, type Metric, type ModelRow, type Summary } from '../lib/activityStats';
import { pct } from '../lib/format';
import { costText, hitRate } from './activityFormat';
import { TokenCell } from './TokenCell';
import { ProviderGlyph } from './ui';

const NUMERIC_COLUMNS = ['Requests', 'Input', 'Output', 'Cache read', 'Cache write', 'Cache hit', 'API cost'];
/** Model, the numeric columns, and Share. */
const MODEL_COLUMN_COUNT = NUMERIC_COLUMNS.length + 2;

/** Per-model totals; Share is each model's part of `metric`. */
export function ModelTable(props: { models: ModelRow[]; total: Summary; metric: Metric }) {
  const share = (s: Summary) => {
    const all = metricValue(props.total, props.metric);
    return all > 0 ? metricValue(s, props.metric) / all : 0;
  };
  return (
    <table class="table dense">
      <thead>
        <tr>
          <th>Model</th><For each={NUMERIC_COLUMNS}>{(c) => <th class="num">{c}</th>}</For><th>Share</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.models} fallback={<tr><td colSpan={MODEL_COLUMN_COUNT} class="muted">No requests in this range.</td></tr>}>
          {(m) => (
            <tr>
              <td class="fill" title={m.model}><div class="cell-name"><ProviderGlyph provider={m.provider} size={14} /><span class="tabular">{m.model || '—'}</span></div></td>
              <td class="tabular num">{m.summary.requests.toLocaleString()}</td>
              <TokenCell v={m.summary.inputTokens} />
              <TokenCell v={m.summary.outputTokens} />
              <TokenCell v={m.summary.cachedTokens} />
              <TokenCell v={m.summary.cacheWriteTokens} provider={m.provider} />
              <td class="tabular num">{hitRate(m.summary)}</td>
              <td class="tabular num">{costText(m.summary)}</td>
              <td class="share-cell"><div class="share-bar" title={pct(share(m.summary) * 100, 1)}><span style={{ width: `${share(m.summary) * 100}%` }} /></div></td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}
