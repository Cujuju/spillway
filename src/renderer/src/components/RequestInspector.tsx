import { createEffect, createSignal, For, Show } from 'solid-js';
import type { ArchiveDetail } from '@shared/archive';
import { shownText } from '../store';
import '../styles/archive.css';

const RENDER_CHUNK = 32 * 1024;
function BodyText(props: { label: string; text: string; type: string; encoding: string }) {
  const [limit, setLimit] = createSignal(RENDER_CHUNK);
  const text = () => {
    const value = shownText(props.text);
    if (value.length > RENDER_CHUNK) return value;
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; /* SSE, plain text and binary wire bytes are displayed verbatim. */ }
  };
  return <section class="archive-body">
    <h3>{props.label} <small class="muted">{shownText(props.type)} {shownText(props.encoding)}</small></h3>
    <pre>{text().slice(0, limit()) || 'No body bytes stored.'}</pre>
    <Show when={text().length > limit()}><button class="btn ghost" type="button" onClick={() => setLimit((n) => n + RENDER_CHUNK)}>Show next 32 KiB</button></Show>
  </section>;
}

export function RequestInspector(props: { traceId?: string | null; onConversation?: (sessionId: string) => void }) {
  const [detail, setDetail] = createSignal<ArchiveDetail | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  let generation = 0;
  const load = async (trace: string | null | undefined) => {
    const gen = ++generation;
    setDetail(null); setError(null);
    if (!trace) { setLoading(false); return; }
    setLoading(true);
    try { const d = await window.api.archiveDetail(trace); if (gen === generation) setDetail(d); }
    catch (e) { if (gen === generation) setError(String(e)); }
    finally { if (gen === generation) setLoading(false); }
  };
  createEffect(() => { void load(props.traceId); });
  return <div class="request-inspector">
    <div class="card-spaced"><strong>Request inspector</strong> <button type="button" class="btn ghost" onClick={() => void load(props.traceId)}>Refresh</button></div>
    <Show when={loading()}><p class="muted">Loading capture…</p></Show>
    <Show when={error()}>{(e) => <p class="notice">{shownText(e())}</p>}</Show>
    <Show when={!loading() && !error() && !detail()}><p class="muted">Unknown — no saved full inbound trace/capture identity. Historical requests and imported client logs cannot be matched safely.</p></Show>
    <Show when={detail()}>{(d) => <>
      <p><span class="badge">{d().state}</span> {shownText(d().reason || 'Finalized downstream exchange')}. {d().bytes.toLocaleString()} stored bytes.</p>
      <p class="archive-identities">Trace {shownText(d().traceId)} · {shownText(d().method)} {shownText(d().path)} · HTTP {d().status || 'unknown'}</p>
      <Show when={d().state === 'pending'}><p class="muted">Awaiting finalization. Long-lived connections remain pending; refresh after the connection closes.</p></Show>
      <Show when={d().state === 'expired'}><p class="muted">Body and search text were deleted by retention or byte budget. The stable identity remains.</p></Show>
      <Show when={d().sessionId && props.onConversation}><button class="btn ghost" type="button" onClick={() => props.onConversation?.(d().sessionId!)}>Browse this conversation</button></Show>
      <details><summary>{d().attempts.length} linked upstream attempts (up to 200 retained)</summary><For each={d().attempts}>{(a) => <p class="archive-identities">{shownText(a.requestId)} · selection {shownText(a.selectionId ?? 'unknown')} · {new Date(a.at).toLocaleString()}</p>}</For></details>
      <div class="archive-bodies">
        <BodyText label="Request" text={d().request} type={d().requestType} encoding={d().requestEncoding} />
        <BodyText label="Response" text={d().response} type={d().responseType} encoding={d().responseEncoding} />
      </div>
      <p class="muted">Captured downstream wire text may contain prompts, completions and secrets inside the body. Headers are excluded. “Complete” means the observed HTTP bytes fit the limit; it does not certify upstream success or application-level completeness.</p>
    </>}</Show>
  </div>;
}
