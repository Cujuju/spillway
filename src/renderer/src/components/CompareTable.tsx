import { For, Show, type JSX } from 'solid-js';
import type { CompareReport, CompareRow, DaySpan } from '@shared/activityCompare';
import { currentRates } from '@shared/modelPrices';
import { comboName, comboRow, modelName } from '../lib/comboSelection';
import { coverageStart, daysOf, money, multiple, points, share, spanText } from '../lib/compareFormat';
import { compactNumber, pct, usd } from '../lib/format';
import { costText } from './activityFormat';

const PER_MILLION = 1_000_000;
/** Mean cost per request sits in fractions of a cent, so it gets a third decimal. */
const REQUEST_COST_DIGITS = 3;
const SHARE_DIGITS = 1;
const MEDIAN_DIGITS = 1;

/** One table row. `value` feeds the baseline comparison; without `kind` the row shows no comparison. */
interface Row {
  label: string;
  sub?: string;
  text: (c: CompareRow) => JSX.Element;
  value?: (c: CompareRow) => number | null;
  kind?: 'multiple' | 'points';
  coverage?: DaySpan | null;
}

/** A combination with no figures (pinned, but absent from this range) shows a dash. */
const dash = '—';
const rate = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const perTask = (c: CompareRow, f: (t: NonNullable<CompareRow['tasks']>) => number) => (c.tasks ? f(c.tasks) : null);
const shown = (v: number | null, f: (v: number) => string) => (v === null ? dash : f(v));
const percent = (v: number | null) => shown(v, (n) => pct(n, SHARE_DIGITS));

function tierText(c: CompareRow): string {
  const { fastRequests: fast, flexRequests: flex, detailRequests: n } = c.whole;
  if (n === 0) return dash;
  const parts = [[fast, 'fast'], [flex, 'flex']].filter(([count]) => (count as number) > 0).map(([count, tier]) => `${pct(share(count as number, n)!)} ${tier}`);
  return parts.length ? parts.join(' · ') : pct(0);
}

function wholeRows(r: CompareReport): Row[] {
  const tokens = (c: CompareRow) => c.whole.promptTokens + c.whole.outputTokens;
  const sharesSub = daysOf(r.shares, r.range);
  return [
    { label: 'List price per MTok', sub: 'input / output', text: (c) => { const p = currentRates(c.model); return p ? `${rate(p.input)} / ${rate(p.output)}` : dash; } },
    { label: '', sub: 'cache read / 5-min write', text: (c) => { const p = currentRates(c.model); return p ? `${usd(p.cacheRead)} / ${usd(p.cacheWrite)}` : dash; } },
    { label: 'API cost', value: (c) => c.whole.costUsd, text: (c) => usd(c.whole.costUsd), kind: 'multiple' },
    { label: 'Requests', value: (c) => c.whole.requests, text: (c) => c.whole.requests.toLocaleString(), kind: 'multiple' },
    { label: 'Cost per request', sub: 'mean', value: (c) => (c.whole.requests ? c.whole.costUsd / c.whole.requests : null), text: (c) => shown(c.whole.requests ? c.whole.costUsd / c.whole.requests : null, (v) => usd(v, REQUEST_COST_DIGITS)), kind: 'multiple' },
    { label: 'Cost per 1M tokens', sub: 'all token types', value: (c) => (tokens(c) ? (c.whole.costUsd / tokens(c)) * PER_MILLION : null), text: (c) => shown(tokens(c) ? (c.whole.costUsd / tokens(c)) * PER_MILLION : null, (v) => usd(v)), kind: 'multiple' },
    { label: 'Cache hit', sub: 'share of input', value: (c) => share(c.whole.cachedTokens, c.whole.promptTokens), text: (c) => percent(share(c.whole.cachedTokens, c.whole.promptTokens)), kind: 'points' },
    { label: 'Failed requests', sub: `share of cost · ${sharesSub}`, value: (c) => share(c.whole.failedCostUsd, c.whole.detailCostUsd), text: (c) => percent(share(c.whole.failedCostUsd, c.whole.detailCostUsd)), kind: 'points', coverage: r.shares },
    { label: 'Thinking', sub: `share of output tokens · ${sharesSub}`, value: (c) => share(c.whole.thinkingTokens, c.whole.thinkingOutputTokens), text: (c) => percent(share(c.whole.thinkingTokens, c.whole.thinkingOutputTokens)), kind: 'points', coverage: r.shares },
    { label: 'Fast or flex tier', sub: `share of requests · ${sharesSub}`, value: (c) => share(c.whole.fastRequests + c.whole.flexRequests, c.whole.detailRequests), text: tierText, kind: 'points', coverage: r.shares },
  ];
}

function taskRows(): Row[] {
  const median = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: MEDIAN_DIGITS });
  return [
    { label: 'Tasks', sub: 'by root session', value: (c) => c.tasks?.tasks ?? null, text: (c) => (c.tasks?.tasks ?? 0).toLocaleString(), kind: 'multiple' },
    { label: 'Cost per task', sub: 'median', value: (c) => perTask(c, (t) => t.medianCostUsd), text: (c) => <b>{shown(perTask(c, (t) => t.medianCostUsd), (v) => usd(v))}</b>, kind: 'multiple' },
    { label: '', sub: 'mean', value: (c) => perTask(c, (t) => t.meanCostUsd), text: (c) => shown(perTask(c, (t) => t.meanCostUsd), (v) => usd(v)), kind: 'multiple' },
    { label: '', sub: '90th percentile', value: (c) => perTask(c, (t) => t.p90CostUsd), text: (c) => shown(perTask(c, (t) => t.p90CostUsd), (v) => usd(v)), kind: 'multiple' },
    { label: 'Tokens per task', sub: 'median', value: (c) => perTask(c, (t) => t.medianTokens), text: (c) => shown(perTask(c, (t) => t.medianTokens), compactNumber), kind: 'multiple' },
    { label: 'Requests per task', sub: 'median', value: (c) => perTask(c, (t) => t.medianRequests), text: (c) => shown(perTask(c, (t) => t.medianRequests), median), kind: 'multiple' },
    { label: 'Mixed tasks', sub: 'subagents on another combination', value: (c) => perTask(c, (t) => share(t.mixed, t.tasks)!),
      text: (c) => shown(perTask(c, (t) => t.mixed), (m) => `${m} · ${pct(share(m, c.tasks!.tasks)!)}`), kind: 'points' },
    { label: '', sub: 'their other-model share of task cost', value: (c) => perTask(c, (t) => share(t.otherCostUsd, t.costUsd) ?? 0),
      text: (c) => shown(perTask(c, (t) => t.otherCostUsd), (o) => `${usd(o)} · ${pct(share(o, c.tasks!.costUsd) ?? 0, SHARE_DIGITS)}`), kind: 'points' },
    { label: 'As subagents in other tasks', sub: 'cost counted under those tasks', value: (c) => c.asSubagentCostUsd, text: (c) => `+ ${money(c.asSubagentCostUsd)}`, kind: 'multiple' },
  ];
}

/** Relative to the baseline column: a multiple, or a difference in points for shares. */
function relative(row: Row, c: CompareRow, base: CompareRow): string | null {
  if (!row.kind || !row.value || c.key === base.key) return null;
  const v = row.value(c), b = row.value(base);
  if (v === null || b === null) return null;
  if (row.kind === 'points') return points(v - b);
  return b === 0 ? null : multiple(v / b);
}

export const Coverage = (props: { part: DaySpan | null; range: DaySpan }) => (
  <span class="cov" title={daysOf(props.part, props.range)}><i style={{ left: `${coverageStart(props.part, props.range)}%` }} /></span>
);

/** Shown combinations side by side: whole range from hourly totals, per task from kept requests. */
export function CompareTable(props: { report: CompareReport; shown: string[]; baseline: string | null; retentionDays: number; onBaseline: (key: string) => void }) {
  const columns = () => props.shown.map((key, i) => ({ i, key, row: comboRow(props.report, key) }));
  const base = () => columns().find((c) => c.key === props.baseline)?.row ?? columns()[0]!.row;
  const span = () => props.shown.length + 1;
  const RowView = (p: { row: Row }) => (
    <tr>
      <td class="lab">{p.row.label}<Show when={p.row.sub}><small>{p.row.sub}</small></Show><Show when={p.row.coverage !== undefined}><Coverage part={p.row.coverage!} range={props.report.range} /></Show></td>
      <For each={columns()}>{(c) => {
        const rel = () => relative(p.row, c.row, base());
        return <td class="num" classList={{ base: c.key === base().key }}>{p.row.text(c.row)} <span class="x" classList={{ blank: !rel() }}>{rel() ?? '0'}</span></td>;
      }}</For>
    </tr>
  );
  const unknown = () => props.report.unknownEffort;
  return (
    <table class="table cmp">
      <thead><tr><th />
        <For each={columns()}>{(c) => (
          <th class="num combo" classList={{ base: c.key === base().key }} tabIndex={0} role="button" aria-pressed={c.key === base().key}
            onClick={() => props.onBaseline(c.key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onBaseline(c.key); } }}>
            <span class="n"><span class={`swatch series-${c.i + 1}`} />{comboName(c.key)}</span> <span class="x blank">0</span>
            <small><Show when={c.key === base().key} fallback={<span class="act">use as baseline</span>}>baseline</Show> <span class="x blank">0</span></small>
          </th>
        )}</For>
      </tr></thead>
      <tbody>
        <tr class="group-row"><td colSpan={span()}>Whole range<span class="gnote">{spanText(props.report.range)} · {props.report.range.days} days · from hourly totals</span></td></tr>
        <For each={wholeRows(props.report)}>{(row) => <RowView row={row} />}</For>
        <tr class="group-row"><td colSpan={span()}>Per task (covered days)<span class="gnote">
          {props.report.retained ? `${spanText(props.report.retained)} · ${daysOf(props.report.retained, props.report.range)}` : 'No kept requests in this range'} · requests are kept {props.retentionDays} days</span>
          <Coverage part={props.report.retained} range={props.report.range} /></td></tr>
        <For each={taskRows()}>{(row) => <RowView row={row} />}</For>
      </tbody>
      <Show when={unknown().requests > 0}>
        <tfoot><tr><td colSpan={span()}>
          Not in any column: {unknown().requests.toLocaleString()} requests with no recorded effort, {costText(unknown())} ({unknown().models.map((m) => `${modelName(m.model)}: ${m.requests.toLocaleString()} requests, ${costText(m)}`).join(' · ')}).
        </td></tr></tfoot>
      </Show>
    </table>
  );
}

