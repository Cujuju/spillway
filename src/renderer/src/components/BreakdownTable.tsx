import { For, Show } from 'solid-js';
import { metricValue, type Metric, type Summary } from '../lib/activityStats';
import { pct } from '../lib/format';
import { costText, hitRate } from './activityFormat';
import { TokenCell } from './TokenCell';
import { ProviderGlyph } from './ui';

const NUMERIC_COLUMNS = ['Requests', 'Input', 'Output', 'Cache read', 'Cache write', 'Cache hit', 'API cost'];
/** Name, the numeric columns, and Share. */
const COLUMN_COUNT = NUMERIC_COLUMNS.length + 2;

/** One row of a breakdown: a model, an account, a client… */
export interface BreakdownRow {
  key: string;
  /** Unset for rows that span providers (clients); they show no glyph. */
  provider?: string;
  name: string;
  summary: Summary;
}

/** Totals per row; Share is each row's part of `metric`. `heading` names the first column. */
export function BreakdownTable(props: { heading: string; rows: BreakdownRow[]; total: Summary; metric: Metric }) {
  const share = (s: Summary) => {
    const all = metricValue(props.total, props.metric);
    return all > 0 ? metricValue(s, props.metric) / all : 0;
  };
  return (
    <table class="table dense">
      <thead>
        <tr>
          <th>{props.heading}</th><For each={NUMERIC_COLUMNS}>{(c) => <th class="num">{c}</th>}</For><th>Share</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows} fallback={<tr><td colSpan={COLUMN_COUNT} class="muted">No requests in this range.</td></tr>}>
          {(r) => (
            <tr>
              <td class="fill" title={r.name}><div class="cell-name"><Show when={r.provider}>{(p) => <ProviderGlyph provider={p()} size="sm" />}</Show><span class="tabular">{r.name || '—'}</span></div></td>
              <td class="tabular num">{r.summary.requests.toLocaleString()}</td>
              <TokenCell v={r.summary.inputTokens} />
              <TokenCell v={r.summary.outputTokens} />
              <TokenCell v={r.summary.cachedTokens} />
              <TokenCell v={r.summary.cacheWriteTokens} provider={r.provider} />
              <td class="tabular num">{hitRate(r.summary)}</td>
              <td class="tabular num">{costText(r.summary)}</td>
              <td class="share-cell"><div class="share-bar" title={pct(share(r.summary) * 100, 1)}><span style={{ width: `${share(r.summary) * 100}%` }} /></div></td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}
