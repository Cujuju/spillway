import { createEffect, createMemo, For, Show, type JSX } from 'solid-js';
import { transportRows } from '@shared/activityTransport';
import { promptTokens } from '@shared/modelPrices';
import type { TraceAttempt } from '@shared/sessionTrace';
import { DIAGNOSTIC_LIMITS } from '@shared/diagnosticBundle';
import { shownText } from '../store';
import { compactNumber, dateTime, msDuration } from '../lib/format';
import { attemptStatus, CAPTURE_LABEL, CAPTURE_TONE, captureReasonText, costText, SESSION_KIND_LABEL } from '../lib/traceFormat';
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
    ...transportRows(a),
  ];
}

/** A badge where text was kept (captured, partial, pending); a muted dash where none was. Hover gives the state and why. */
function CaptureBadge(props: { a: TraceAttempt }) {
  const state = () => props.a.captureState;
  return (
    <HoverTip title="Capture" rows={[{ label: 'State', value: CAPTURE_LABEL[state()] }]} note={props.a.captureReason ? shownText(captureReasonText(props.a.captureReason)) : undefined}>
      <Show when={CAPTURE_TONE[state()]} fallback={<span class="muted">—</span>}>{(tone) => <span class={`badge compact ${tone()}`}>{CAPTURE_LABEL[state()]}</span>}</Show>
    </HoverTip>
  );
}

/** Requests picked for a diagnostic bundle, by trace ID. */
export interface BundlePicks { picked: readonly string[]; onPick: (traceId: string, on: boolean) => void }

function AttemptRow(props: { a: TraceAttempt; account: (id: string | null) => string; onInspect: (traceId: string) => void; inspected: boolean; picks: BundlePicks; capture: boolean }) {
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
      <td class="col-check" onClick={(e) => e.stopPropagation()}>
        <Show when={a().traceId}>{(t) => {
          const picked = () => props.picks.picked.includes(t());
          return <input type="checkbox" aria-label="Add to diagnostic bundle" checked={picked()}
            disabled={!picked() && props.picks.picked.length >= DIAGNOSTIC_LIMITS.records} onChange={(e) => props.picks.onPick(t(), e.currentTarget.checked)} />;
        }}</Show>
      </td>
      <td class="tabular">
        <HoverTip title="Attempt" rows={identityRows(a(), account(), a().movedFrom ? shownText(props.account(a().movedFrom)) : null)}>{dateTime(a().at)}</HoverTip>
      </td>
      <td class="fill">
        <div class="cell-name">
          <Show when={a().provider}>{(p) => <ProviderGlyph provider={p()} size="sm" />}</Show>
          <span title={or(a().effectiveModel ?? a().model)}>{or(a().effectiveModel ?? a().model)}</span>
          <Show when={a().source === 'client-log'}><span class="badge compact">Imported</span></Show>
          <Show when={a().origin === 'archive'}><span class="badge compact">Capture only</span></Show>
          <Show when={a().compactionEndpoint}><span class="badge compact accent">Compact</span></Show>
        </div>
      </td>
      <td>{a().reasoningEffort ?? <span class="muted">—</span>}</td>
      <td class="trace-account">{account()}<Show when={a().movedFrom}> <span class="badge compact amber">Moved</span></Show></td>
      <td><span class={`badge compact ${status().tone}`}>{status().label}</span></td>
      <Show when={props.capture}><td><CaptureBadge a={a()} /></td></Show>
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

/** Columns in an attempt row without Capture; an inline exchange spans them all. */
const BASE_COLUMNS = 10;

/** A node's attempts, newest first. A row click opens its exchange, inline under its newest attempt when `exchange` is set. Capture shows only when some attempt kept text. */
export function TraceAttempts(props: {
  attempts: TraceAttempt[]; busy: boolean; account: (id: string | null) => string; onInspect: (traceId: string) => void;
  inspected?: string; exchange?: (traceId: string) => JSX.Element; picks: BundlePicks;
}) {
  /** A retried exchange has several attempts; it opens under the first (newest) one. */
  const firstAttempt = createMemo(() => {
    const first = new Map<string, TraceAttempt>();
    for (const a of props.attempts) if (a.traceId && !first.has(a.traceId)) first.set(a.traceId, a);
    return first;
  });
  const capture = createMemo(() => props.attempts.some((a) => CAPTURE_TONE[a.captureState]));
  const columns = () => BASE_COLUMNS + (capture() ? 1 : 0);
  return (
    <div class="trace-table">
      <table class="table dense">
        <thead>
          <tr>
            <th class="col-check" /><th>Time</th><th>Model</th><th>Effort</th><th>Account</th><th>Status</th><Show when={capture()}><th>Capture</th></Show>
            <th class="num" title="Prompt / output tokens">Tokens</th><th class="num">Cost</th><th class="num">TTFT</th><th class="num">Total</th>
          </tr>
        </thead>
        <tbody aria-busy={props.busy}>
          <For each={props.attempts} fallback={<tr><td class="empty-row" colSpan={columns()}>{props.busy ? 'Loading…' : 'No attempts in this range.'}</td></tr>}>
            {(a) => {
              const open = () => !!a.traceId && a.traceId === props.inspected && firstAttempt().get(a.traceId) === a;
              return <>
                <AttemptRow a={a} account={props.account} onInspect={props.onInspect} inspected={open()} picks={props.picks} capture={capture()} />
                <Show when={open() && props.exchange}>{(render) => <tr class="row-exchange"><td colSpan={columns()}>{render()(a.traceId!)}</td></tr>}</Show>
              </>;
            }}
          </For>
        </tbody>
      </table>
    </div>
  );
}
