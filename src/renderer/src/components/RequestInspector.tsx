import { ChevronDown, ChevronUp, FileArchive, FlaskConical, MessagesSquare, RefreshCw, Settings2, X } from 'lucide-solid';
import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import type { ArchiveDetail, CaptureState } from '@shared/archive';
import { openSettings, shownText } from '../store';
import { CAPTURE_LABEL, CAPTURE_TONE, captureReasonText, RECORDING_OFF_REASONS } from '../lib/traceFormat';
import type { InspectorStep } from '../lib/exchangeNav';
import { parseExchange, type ExchangeSides } from '../lib/exchangeParse';
import { byteSize, dateTime } from '../lib/format';
import { HoverTip, InfoTip } from './ChartTip';
import { DiagnosticBundle } from './DiagnosticBundle';
import { ExchangeBody } from './ExchangeBody';
import '../styles/archive.css';

/** A pending capture's open WebSocket messages arrive while it is shown. */
const LIVE_REFRESH_MS = 3_000;
/** Settled captures change only by expiry or a late capture; manual Refresh covers both, so polling stops. */
const SETTLED: ReadonlySet<CaptureState> = new Set(['complete', 'partial', 'missing', 'expired']);
/** An open WebSocket reports partial once a frame is cut and keeps recording, so it never counts as settled. */
const settled = (d: ArchiveDetail | null) => !!d && SETTLED.has(d.state) && !(d.format === 'websocket' && d.state === 'partial');
const ICON_PX = 14;
/** Newest upstream attempts listed in the hover readout; the count shows them all. */
const ATTEMPT_TIP_ROWS = 8;
const EVAL_NOTE = 'Pin this exchange as a new eval case, under Activity → Evals.';
const BUNDLE_NOTE = 'Save this exchange with its metadata and logs as a file to attach to a bug report.';
const hasText = (d: ArchiveDetail) => !!(d.request || d.response || d.frames.length);
const STATUS_NOTE = 'What the proxy returned to the client. Each upstream try, retries included, is under Upstream attempts.';
const FORMAT_NOTE = 'HTTP encodings are decoded when supported; WebSocket payloads are decoded messages. Headers are excluded; prompts and body secrets may be present. "Captured" means all observed bytes within limits, not upstream success.';

/** Body inputs unchanged: live refreshes keep the parsed sides, their DOM and scroll. */
const sameBodies = (a: ArchiveDetail | null, b: ArchiveDetail | null) => !!a && !!b && a.traceId === b.traceId && a.reason === b.reason
  && a.request === b.request && a.response === b.response && a.frames.length === b.frames.length;

/** Text never recorded because Record bodies was off: one line, linking to the setting. */
function RecordBodiesOff() {
  return <div class="archive-no-text">
    <span>No text recorded: Record bodies was off.</span>
    <HoverTip title="Record bodies" rows={[]} note="Settings → Data → Request capture. Once on, new requests keep their text; this one stays without." layout="contents">
      <button class="btn" type="button" onClick={() => openSettings('capture')}><Settings2 size={ICON_PX} />Request capture</button>
    </HoverTip>
  </div>;
}

export function RequestInspector(props: { traceId?: string | null; onConversation?: (sessionId: string) => void; onClose?: () => void; step?: InspectorStep; onEval?: (traceId: string) => void }) {
  const [bundle, setBundle] = createSignal<string>();
  const [detail, setDetail] = createSignal<ArchiveDetail | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const bodies = createMemo(() => detail(), null, { equals: sameBodies });
  /** Parsed sides of the current bodies; parsing runs in a worker, and a newer capture aborts the older parse. */
  const [sides, setSides] = createSignal<{ detail: ArchiveDetail; sides: ExchangeSides } | null>(null);
  const [parseError, setParseError] = createSignal<string | null>(null);
  createEffect(() => {
    const b = bodies(); setSides(null); setParseError(null);
    if (!b) return;
    const parse = new AbortController();
    parseExchange(b, parse.signal).then((parsed) => setSides({ detail: b, sides: parsed }),
      (e: unknown) => { if (!(e instanceof DOMException && e.name === 'AbortError')) setParseError(String(e)); });
    onCleanup(() => parse.abort());
  });
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
    const timer = setInterval(() => { if (!settled(detail())) void load(trace, true); }, LIVE_REFRESH_MS);
    onCleanup(() => { clearInterval(timer); generation++; });
  });
  return <div class="request-inspector">
    <div class="panel-head">
      <h2 class="card-title">Exchange</h2>
      <Show when={detail()}>{(d) => <>
        <span class={`badge ${CAPTURE_TONE[d().state]}`}>{CAPTURE_LABEL[d().state]}</span>
        <Show when={d().reason && !RECORDING_OFF_REASONS.has(d().reason)}><InfoTip title={CAPTURE_LABEL[d().state]} note={shownText(captureReasonText(d().reason))} /></Show>
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
        <Show when={detail() && props.onEval}>
          <HoverTip title="Eval case" rows={[]} note={EVAL_NOTE} layout="contents">
            <button class="btn icon-btn ghost" type="button" aria-label="New eval case" onClick={() => props.onEval?.(detail()!.traceId)}><FlaskConical size={ICON_PX} /></button>
          </HoverTip>
        </Show>
        <Show when={props.traceId}>
          <HoverTip title="Diagnostic bundle" rows={[]} note={BUNDLE_NOTE} layout="contents">
            <button class="btn icon-btn ghost" type="button" aria-label="Diagnostic bundle" onClick={() => setBundle(props.traceId!)}><FileArchive size={ICON_PX} /></button>
          </HoverTip>
        </Show>
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
        {/* A metadata-only record has no request line, status or format; its attempts still say what happened. */}
        <Show when={d().method || d().path}><div class="kv"><dt>Request</dt><dd>{shownText([d().method, d().path].filter(Boolean).join(' '))}</dd></div></Show>
        <Show when={d().status}><div class="kv"><dt>Status</dt><dd>{d().status}<InfoTip title="Status" note={STATUS_NOTE} /></dd></div></Show>
        <Show when={d().bytes}><div class="kv"><dt>Stored</dt><dd>{byteSize(d().bytes)}</dd></div></Show>
        <Show when={hasText(d())}><div class="kv"><dt>Format</dt><dd>{d().format}<InfoTip title="Format" note={FORMAT_NOTE} /></dd></div></Show>
        <div class="kv"><dt>Upstream attempts</dt><dd>
          <HoverTip title="Upstream attempts" rows={d().attempts.slice(0, ATTEMPT_TIP_ROWS).map((a) => ({ label: dateTime(a.at), value: shownText([a.provenance?.statusCode, a.selectionId ?? a.requestId].filter(Boolean).join(' · ')) }))} note={d().attempts.length > ATTEMPT_TIP_ROWS ? `First ${ATTEMPT_TIP_ROWS} of ${d().attempts.length}; up to 200 retained.` : 'Up to 200 retained.'}>
            <span>{d().attempts.length}</span>
          </HoverTip>
        </dd></div>
        <div class="kv kv-wide"><dt>Trace</dt><dd class="selectable">{shownText(d().traceId)}</dd></div>
      </dl>
      <Show when={hasText(d())} fallback={
        <Show when={RECORDING_OFF_REASONS.has(d().reason)} fallback={<p class="archive-no-text">No text stored.</p>}>
          <RecordBodiesOff />
        </Show>
      }>
        <Show when={parseError()}>{(e) => <p class="notice error">{shownText(e())}</p>}</Show>
        <Show when={sides()} keyed fallback={<Show when={!parseError()}><p class="empty-note">Reading bodies…</p></Show>}>{(p) => (
          <div class="archive-bodies">
            <ExchangeBody label="Request" side={p.sides.request} type={p.detail.requestType} encoding={p.detail.requestEncoding} />
            <ExchangeBody label="Response" side={p.sides.response} type={p.detail.responseType} encoding={p.detail.responseEncoding} />
          </div>
        )}</Show>
      </Show>
    </>}</Show>
  </div>;
}
