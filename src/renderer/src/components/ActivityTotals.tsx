import { createMemo, createSignal, For, onCleanup, onMount } from 'solid-js';
import { addCounts, emptyCounts } from '@shared/activityCounts';
import type { ActivityCounts, ActivityDayTotal } from '@shared/types';
import { dayLabel } from '../lib/format';
import { costText } from './activityFormat';
import { TokenCell } from './TokenCell';
import { ProviderGlyph } from './ui';

/** A burst of requests reloads the totals once, after it settles. */
const RELOAD_DEBOUNCE_MS = 2_000;

const sum = (rows: ActivityCounts[]): ActivityCounts => {
  const total = emptyCounts();
  for (const r of rows) addCounts(total, r);
  return total;
};
const n = (v: number) => v.toLocaleString();
const COLUMN_COUNT = 9;

/** `provider` is unset on a day row, which sums every provider. */
function CountCells(props: { c: ActivityCounts; provider?: string }) {
  return (
    <>
      <td class="tabular num">{n(props.c.requests)}</td>
      <td class="tabular num" classList={{ zero: !props.c.failed }}>{n(props.c.failed)}</td>
      <TokenCell v={props.c.inputTokens} />
      <TokenCell v={props.c.outputTokens} />
      <TokenCell v={props.c.cachedTokens} />
      <TokenCell v={props.c.cacheWriteTokens} provider={props.provider} />
      <td class="tabular num" title={props.c.unpricedRequests ? `${n(props.c.unpricedRequests)} requests on models without a price are left out` : undefined}>
        {costText(props.c)}
      </td>
    </>
  );
}

/** Per-day totals, newest day first, broken down by account and model. */
export function ActivityTotals(props: { account: (authIndex: string | null) => string }) {
  const [totals, setTotals] = createSignal<ActivityDayTotal[]>([]);
  const load = () => void window.api.activityTotals().then(setTotals);
  onMount(load);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(window.api.onActivity(() => {
    clearTimeout(timer);
    timer = setTimeout(load, RELOAD_DEBOUNCE_MS);
  }));
  onCleanup(() => clearTimeout(timer));

  const days = createMemo(() => {
    const groups = new Map<string, ActivityDayTotal[]>();
    for (const t of totals()) groups.set(t.day, [...(groups.get(t.day) ?? []), t]);
    return [...groups]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, rows]) => ({ day, total: sum(rows), rows: [...rows].sort((x, y) => y.requests - x.requests) }));
  });

  return (
    <div class="card table-card">
    <table class="table dense">
      <thead>
        <tr>
          <th>Day / account</th>
          <th>Model</th>
          <th class="num">Requests</th>
          <th class="num">Failed</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Cache read</th>
          <th class="num">Cache write</th>
          <th class="num" title="At API list prices">API cost</th>
        </tr>
      </thead>
      <tbody>
        <For each={days()} fallback={<tr><td colSpan={COLUMN_COUNT} class="muted">No requests recorded yet.</td></tr>}>
          {(d) => (
            <>
              <tr class="group-row">
                <td colSpan={2}>{dayLabel(d.day)}</td>
                <CountCells c={d.total} />
              </tr>
              <For each={d.rows}>
                {(r) => (
                  <tr class="child-row">
                    <td class="fill" title={props.account(r.authIndex)}>
                      <div class="cell-name">
                        <ProviderGlyph provider={r.provider} size="sm" />
                        <span>{props.account(r.authIndex)}</span>
                      </div>
                    </td>
                    <td class="tabular">{r.model || '—'}</td>
                    <CountCells c={r} provider={r.provider} />
                  </tr>
                )}
              </For>
            </>
          )}
        </For>
      </tbody>
    </table>
    </div>
  );
}
