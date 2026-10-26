import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount } from 'solid-js';
import type { ActivityDayTotal } from '@shared/types';
import { dayLabel } from '../lib/format';
import { activity } from '../store';
import { ProviderGlyph } from './ui';

/** A burst of requests reloads the totals once, after it settles. */
const RELOAD_DEBOUNCE_MS = 2_000;

type Counts = Pick<ActivityDayTotal, 'requests' | 'failed' | 'inputTokens' | 'outputTokens' | 'cachedTokens'>;
const ZERO: Counts = { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
const sum = (rows: Counts[]): Counts =>
  rows.reduce((a, r) => ({
    requests: a.requests + r.requests,
    failed: a.failed + r.failed,
    inputTokens: a.inputTokens + r.inputTokens,
    outputTokens: a.outputTokens + r.outputTokens,
    cachedTokens: a.cachedTokens + r.cachedTokens,
  }), ZERO);
const n = (v: number) => v.toLocaleString();

function CountCells(props: { c: Counts }) {
  return (
    <>
      <td class="tabular">{n(props.c.requests)}</td>
      <td class="tabular">{n(props.c.failed)}</td>
      <td class="tabular">{n(props.c.inputTokens)} / {n(props.c.outputTokens)} / {n(props.c.cachedTokens)}</td>
    </>
  );
}

/** Per-day totals, newest day first, broken down by account and model. */
export function ActivityTotals(props: { account: (authIndex: string | null) => string }) {
  const [totals, setTotals] = createSignal<ActivityDayTotal[]>([]);
  const load = () => void window.api.activityTotals().then(setTotals);
  onMount(load);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(activity, () => {
    clearTimeout(timer);
    timer = setTimeout(load, RELOAD_DEBOUNCE_MS);
  }, { defer: true }));
  onCleanup(() => clearTimeout(timer));

  const days = createMemo(() => {
    const groups = new Map<string, ActivityDayTotal[]>();
    for (const t of totals()) groups.set(t.day, [...(groups.get(t.day) ?? []), t]);
    return [...groups]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, rows]) => ({ day, total: sum(rows), rows: [...rows].sort((x, y) => y.requests - x.requests) }));
  });

  return (
    <table class="table">
      <thead>
        <tr>
          <th>Day / account</th>
          <th>Model</th>
          <th>Requests</th>
          <th>Failed</th>
          <th title="Input / output / cached tokens">Tokens</th>
        </tr>
      </thead>
      <tbody>
        <For each={days()} fallback={<tr><td colSpan={5} class="muted">No requests recorded yet.</td></tr>}>
          {(d) => (
            <>
              <tr style={{ 'font-weight': 600 }}>
                <td colSpan={2}>{dayLabel(d.day)}</td>
                <CountCells c={d.total} />
              </tr>
              <For each={d.rows}>
                {(r) => (
                  <tr>
                    <td>
                      <div class="row" style={{ gap: '8px', 'padding-left': '12px' }}>
                        <ProviderGlyph provider={r.provider} size={14} />
                        <span>{props.account(r.authIndex)}</span>
                      </div>
                    </td>
                    <td class="tabular">{r.model || '—'}</td>
                    <CountCells c={r} />
                  </tr>
                )}
              </For>
            </>
          )}
        </For>
      </tbody>
    </table>
  );
}
