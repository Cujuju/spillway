import { ChevronDown, ChevronUp, FileArchive, MessagesSquare, RefreshCw, X } from 'lucide-solid';
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import type { ArchiveDetail } from '@shared/archive';
import { readableStreamText } from '@shared/archiveContent';
import { shownText } from '../store';
import { CAPTURE_LABEL, CAPTURE_TONE } from '../lib/traceFormat';
import { dateTime } from '../lib/format';
import { HoverTip, InfoTip } from './ChartTip';
import { DiagnosticBundle } from './DiagnosticBundle';
import '../styles/archive.css';

const RENDER_CHUNK = 32 * 1024;
/** A pending capture's open WebSocket messages arrive while it is shown. */
const LIVE_REFRESH_MS = 3_000;
const ICON_PX = 14;
const KIB = 1024;
/** Newest upstream attempts listed in the hover readout; the count shows them all. */
const ATTEMPT_TIP_ROWS = 8;
const STATE_NOTE: Partial<Record<ArchiveDetail['state'], string>> = {
  pending: 'Awaiting finalization; open WebSocket messages update here.',
  expired: 'Bodies were removed by retention or the byte budget. The identity remains.',
};
const FORMAT_NOTE = 'HTTP encodings are decoded when supported; WebSocket payloads are decoded messages. Headers are excluded; prompts and body secrets may be present. "Captured" means all observed bytes within limits, not upstream success.';

function BodyText(props: { label: string; text: string; type: string; encoding: string }) {
  const [limit, setLimit] = createSignal(RENDER_CHUNK);
  const text = createMemo(() => {
    const value = shownText(props.text);
    if (value.length > RENDER_CHUNK) return value;
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; /* SSE, plain text and binary wire bytes are displayed verbatim. */ }
  });
  return <section class="archive-body">
    <div class="archive-body-head"><span class="section-label">{props.label}</span><span class="muted">{shownText([props.type, props.encoding].filter(Boolean).join(' · '))}</span></div>
    <pre>{text().slice(0, limit()) || 'No body stored.'}</pre>
    <Show when={text().length > limit()}><button class="btn ghost" type="button" onClick={() => setLimit((n) => n + RENDER_CHUNK)}>Show more</button></Show>
  </section>;
}

/** Where the shown exchange sits in its list: `index` of `count`, -1 when not listed. */
export interface InspectorStep { index: number; count: number; onStep: (delta: -1 | 1) => void }

export function RequestInspector(props: { traceId?: string | null; onConversation?: (sessionId: string) => void; onClose?: () => void; step?: InspectorStep }) {
  const [bundle, setBundle] = createSignal<string>();
  const [detail, setDetail] = createSignal<ArchiveDetail | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const readableResponse = createMemo(() => { const d = detail(); return d ? readableStreamText(d.response, d.frames.filter((f) => f.direction === 'response')) : ''; });
  let generation = 0;
  const load = async (trace: string | null | undefined, quiet = false) => {
    const gen = ++generation;
    if (!quiet) setDetail(null); setError(null);
    if (!trace) { setLoading(false); return; }
    if (!quiet) setLoading(true);
    try { const d = await window.api.archiveDetail(trace); if (gen === generation) setDetail(d); }
    catch (e) { if (gen === generation) setError(String(e)); }
    finally { if (gen === generation) setLoading(false); }
  };
  createEffect(() => {
    const trace = props.traceId; void load(trace);
    const timer = setInterval(() => void load(trace, true), LIVE_REFRESH_MS);
    onCleanup(() => { clearInterval(timer); generation++; });
  });
  return <div class="request-inspector">
    <div class="panel-head">
      <h2 class="card-title">Exchange</h2>
      <Show when={detail()}>{(d) => <>
        <span class={`badge ${CAPTURE_TONE[d().state]}`}>{CAPTURE_LABEL[d().state]}</span>
        <Show when={STATE_NOTE[d().state] || d().reason}><InfoTip title={CAPTURE_LABEL[d().state]} note={[STATE_NOTE[d().state], d().reason && shownText(d().reason)].filter(Boolean).join(' ')} /></Show>
      </>}</Show>
      <div class="panel-head-end">
        <Show when={props.step}>{(s) => (
          <span class="inspector-step">
            <button type="button" class="btn icon-btn ghost" title="Previous request (↑)" aria-label="Previous request" disabled={s().index <= 0} onClick={() => s().onStep(-1)}><ChevronUp size={ICON_PX} /></button>
            <span class="panel-count">{s().index + 1} of {s().count}</span>
            <button type="button" class="btn icon-btn ghost" title="Next request (↓)" aria-label="Next request" disabled={s().index < 0 || s().index >= s().count - 1} onClick={() => s().onStep(1)}><ChevronDown size={ICON_PX} /></button>
          </span>
        )}</Show>
        <Show when={detail()?.sessionId && props.onConversation}><button class="btn ghost" type="button" onClick={() => props.onConversation?.(detail()!.sessionId!)}><MessagesSquare size={ICON_PX} />Conversation</button></Show>
        <Show when={props.traceId}><button class="btn ghost" type="button" onClick={() => setBundle(props.traceId!)}><FileArchive size={ICON_PX} />Diagnostic bundle</button></Show>
        <button type="button" class="btn icon-btn ghost" title="Refresh" aria-label="Refresh" onClick={() => void load(props.traceId)}><RefreshCw size={ICON_PX} /></button>
        <Show when={props.onClose}><button type="button" class="btn icon-btn ghost" title={props.step ? 'Close (Esc)' : 'Close'} aria-label="Close" onClick={() => props.onClose?.()}><X size={ICON_PX} /></button></Show>
      </div>
    </div>
    <Show when={bundle()}>{(trace) => <DiagnosticBundle traceIds={[trace()]} onClose={() => setBundle(undefined)} />}</Show>
    <Show when={loading()}><p class="empty-note">Loading…</p></Show>
    <Show when={error()}>{(e) => <p class="notice error">{shownText(e())}</p>}</Show>
    <Show when={!loading() && !error() && !detail()}><p class="empty-note">No capture for this request. Imported and older requests have no capture ID.</p></Show>
    <Show when={detail()}>{(d) => <>
      <dl class="kv-grid">
        <div class="kv"><dt>Request</dt><dd>{shownText([d().method, d().path].filter(Boolean).join(' ')) || '—'}</dd></div>
        <div class="kv"><dt>Status</dt><dd>{d().status || '—'}</dd></div>
        <div class="kv"><dt>Stored</dt><dd>{(d().bytes / KIB).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB</dd></div>
        <div class="kv"><dt>Format</dt><dd>{d().format}<InfoTip title="Format" note={FORMAT_NOTE} /></dd></div>
        <div class="kv"><dt>Upstream attempts</dt><dd>
          <HoverTip title="Upstream attempts" rows={d().attempts.slice(0, ATTEMPT_TIP_ROWS).map((a) => ({ label: dateTime(a.at), value: shownText(a.selectionId ?? a.requestId) }))} note={d().attempts.length > ATTEMPT_TIP_ROWS ? `First ${ATTEMPT_TIP_ROWS} of ${d().attempts.length}; up to 200 retained.` : 'Up to 200 retained.'}>
            <span>{d().attempts.length}</span>
          </HoverTip>
        </dd></div>
        <div class="kv kv-wide"><dt>Trace</dt><dd class="selectable">{shownText(d().traceId)}</dd></div>
      </dl>
      <Show when={readableResponse()}><BodyText label="Response text" text={readableResponse()} type="Joined deltas" encoding="" /></Show>
      <div class="archive-bodies">
        <BodyText label="Request" text={d().request} type={d().requestType} encoding={d().requestEncoding} />
        <BodyText label="Response" text={d().response} type={d().responseType} encoding={d().responseEncoding} />
      </div>
    </>}</Show>
  </div>;
}
