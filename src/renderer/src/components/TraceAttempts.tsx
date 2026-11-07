import { createEffect, For, Show, type JSX } from 'solid-js';
import { transportRows } from '@shared/activityTransport';
import { promptTokens } from '@shared/modelPrices';
import type { TraceAttempt } from '@shared/sessionTrace';
import { shownText } from '../store';
import { compactNumber, dateTime, msDuration } from '../lib/format';
import { attemptStatus, CAPTURE_LABEL, captureReasonText, costText, SESSION_KIND_LABEL } from '../lib/traceFormat';
import { onRowActivate, REVEAL_ROW } from '../lib/exchangeNav';
import { HoverTip, type TipRow } from './ChartTip';
import { ProviderGlyph } from './ui';

const or = (v: string | null | undefined) => (v ? shownText(v) : '—');

function identityRows(a: TraceAttempt, account: string, movedFrom: string | null): TipRow[] {
  return [
    { label: 'Account', value: account },
    ...(movedFrom ? [{ label: 'Moved from', value: movedFrom }] : []),
    { label: 'Requested', value: or(a.model) },
    { label: 'Provider', value: or(a.provider) },
    { label: 'Client', value: or(a.client) },
    { label: 'Attempt', value: shownText(a.requestId) },
    { label: 'Selection', value: or(a.selectionId) },
    { label: 'Trace', value: or(a.traceId) },
    { label: 'Session kind', value: a.sessionKind ? SESSION_KIND_LABEL[a.sessionKind] : '—' },
    { label: 'Parent session', value: or(a.parentSessionId) },
    { label: 'Capture', value: CAPTURE_LABEL[a.captureState] },
    ...transportRows(a),
  ];
}

function AttemptRow(props: { a: TraceAttempt; account: (id: string | null) => string; onInspect: (traceId: string) => void; inspected: boolean }) {
  const a = () => props.a;
  const account = () => (a().authIndex ? shownText(props.account(a().authIndex)) : '—');
  const status = () => attemptStatus(a());
  const tokens = () => a().tokens;
  let row: HTMLTableRowElement | undefined;
  createEffect(() => { if (props.inspected) row?.scrollIntoView(REVEAL_ROW); });
  return (
    <tr classList={{ selected: props.inspected, inspectable: !!a().traceId }} tabIndex={a().traceId ? 0 : undefined}
      aria-expanded={a().traceId ? props.inspected : undefined}
      onClick={() => { const t = a().traceId; if (t) props.onInspect(t); }}
      ref={row}
      onKeyDown={(e) => onRowActivate(e, () => { const t = a().traceId; if (t) props.onInspect(t); })}>
      <td class="tabular">
        <HoverTip title="Attempt" rows={identityRows(a(), account(), a().movedFrom ? shownText(props.account(a().movedFrom)) : null)} note={a().captureReason ? shownText(captureReasonText(a().captureReason)) : undefined}>{dateTime(a().at)}</HoverTip>
      </td>
      <td class="fill">
        <div class="cell-name">
          <Show when={a().provider}>{(p) => <ProviderGlyph provider={p()} size="sm" />}</Show>
          <span>{or(a().effectiveModel ?? a().model)}</span>
          <Show when={a().source === 'client-log'}><span class="badge compact">Imported</span></Show>
          <Show when={a().origin === 'archive'}><span class="badge compact">Archived</span></Show>
          <Show when={a().compactionEndpoint}><span class="badge compact accent">Compact</span></Show>
        </div>
      </td>
      <td>{a().reasoningEffort ?? <span class="muted">—</span>}</td>
      <td class="trace-account">{account()}<Show when={a().movedFrom}> <span class="badge compact amber">Moved</span></Show></td>
      <td><span class={`badge compact ${status().tone}`}>{status().label}</span></td>
      <td class="num tabular">
        <Show when={tokens()} fallback={<span class="muted">—</span>}>{(t) => (
          <HoverTip title="Tokens" rows={[
            { label: 'Input', value: t().inputTokens.toLocaleString() },
            { label: 'Output', value: t().outputTokens.toLocaleString() },
            { label: 'Cache read', value: t().cachedTokens.toLocaleString() },
            { label: 'Cache write', value: t().cacheWriteTokens.toLocaleString() },
          ]}>{compactNumber(promptTokens(a().provider ?? '', t()))} / {compactNumber(t().outputTokens)}</HoverTip>
        )}</Show>
      </td>
      <td class="num tabular">{costText(a().costUsd)}</td>
      <td class="num tabular">{msDuration(a().ttftMs)}</td>
      <td class="num tabular">{msDuration(a().latencyMs)}</td>
    </tr>
  );
}

/** Columns in an attempt row; an inline exchange spans them all. */
const COLUMNS = 9;

/** A node's own attempts, newest first. Hover the time for IDs and transport; clicking a row opens its captured exchange, under the row when `exchange` is set. */
export function TraceAttempts(props: {
  attempts: TraceAttempt[]; busy: boolean; account: (id: string | null) => string; onInspect: (traceId: string) => void;
  inspected?: string; exchange?: (traceId: string) => JSX.Element;
}) {
  return (
    <div class="trace-table">
      <table class="table dense">
        <thead>
          <tr>
            <th>Time</th><th>Model</th><th>Effort</th><th>Account</th><th>Status</th>
            <th class="num" title="Prompt / output tokens">Tokens</th><th class="num">Cost</th><th class="num">TTFT</th><th class="num">Total</th>
          </tr>
        </thead>
        <tbody aria-busy={props.busy}>
          <For each={props.attempts} fallback={<tr><td class="empty-row" colSpan={COLUMNS}>{props.busy ? 'Loading…' : 'No attempts in this range.'}</td></tr>}>
            {(a) => {
              const open = () => !!a.traceId && a.traceId === props.inspected;
              return <>
                <AttemptRow a={a} account={props.account} onInspect={props.onInspect} inspected={open()} />
                <Show when={open() && props.exchange}>{(render) => <tr class="row-exchange"><td colSpan={COLUMNS}>{render()(a.traceId!)}</td></tr>}</Show>
              </>;
            }}
          </For>
        </tbody>
      </table>
    </div>
  );
}
