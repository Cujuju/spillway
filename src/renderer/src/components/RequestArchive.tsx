import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { DEFAULT_ARCHIVE_POLICY, type ArchiveEntry, type ArchivePolicy, type ArchiveQuery, type ArchiveStatus, type CaptureState } from '@shared/archive';
import { shownText } from '../store';
import { RequestInspector } from './RequestInspector';
import '../styles/archive.css';

const MiB = 1024 * 1024;
export function RequestArchive() {
  const [status, setStatus] = createSignal<ArchiveStatus & { syncError?: string | null }>();
  const [query, setQuery] = createSignal<ArchiveQuery>({});
  const [entries, setEntries] = createSignal<ArchiveEntry[]>([]);
  const [more, setMore] = createSignal(false);
  const [selected, setSelected] = createSignal<string>();
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let generation = 0;
  const load = async (q: ArchiveQuery, append = false) => {
    const gen = ++generation; setBusy(true); setError(null);
    try {
      const [page, s] = await Promise.all([window.api.archiveQuery(q), window.api.archiveStatus()]);
      if (gen !== generation) return;
      setEntries((old) => append ? [...old, ...page.entries] : page.entries); setMore(page.more); setStatus(s);
    } catch (e) { if (gen === generation) setError(String(e)); }
    finally { if (gen === generation) setBusy(false); }
  };
  createEffect(() => { const q = query(); const timer = setTimeout(() => void load(q), 200); onCleanup(() => clearTimeout(timer)); });
  const filter = (key: keyof ArchiveQuery, value: string) => setQuery((q) => ({ ...q, [key]: value || undefined, before: undefined }));
  const policy = () => status()?.policy ?? DEFAULT_ARCHIVE_POLICY;
  const save = async (p: ArchivePolicy) => {
    setBusy(true); setError(null);
    try { setStatus(await window.api.archivePolicy(p)); await load(query()); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try { await window.api.archiveClear(); setSelected(undefined); await load(query()); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <div class="archive-layout">
    <section class="card request-inspector">
      <h2>Local request archive</h2>
      <p>Metadata is recorded by default. Body capture is optional and applies to future traffic while Spillway is connected. Captured text and its full-text index are encrypted with the Activity database key.</p>
      <div class="archive-filters">
        <label><input type="checkbox" checked={policy().captureBodies} disabled={busy()} onChange={(e) => void save({ ...policy(), captureBodies: e.currentTarget.checked })} /> Record request and response bodies</label>
        <label>Keep bodies (days) <input type="number" min="1" max="90" value={policy().retentionDays} disabled={busy()} onChange={(e) => void save({ ...policy(), retentionDays: Number(e.currentTarget.value) })} /></label>
        <label>Body budget (MiB) <input type="number" min="1" max="1024" value={policy().maxBytes / MiB} disabled={busy()} onChange={(e) => void save({ ...policy(), maxBytes: Number(e.currentTarget.value) * MiB })} /></label>
      </div>
      <p class="muted">256 KiB per request and response. Oldest bodies expire first. The budget counts stored body records before index overhead; database file size can be larger. Up to 20,000 metadata identities remain. Turning capture off keeps existing bodies until expiry or deletion.</p>
      <p class="muted">The proxy uses a temporary bounded memory spool. Overflow, disconnection and proxy crashes can lose captures. WebSocket frames are unavailable. This setting is separate from proxy text-file logging.</p>
      <Show when={status()}>{(s) => <p class="muted">{s().entries.toLocaleString()} records · {(s().bytes / MiB).toFixed(1)} MiB · {s().dropped} proxy drops · {s().gaps} sequence gaps · {s().restarts} observed epoch changes</p>}</Show>
      <Show when={status()?.syncError}><p class="notice">Capture sync: {shownText(status()!.syncError!)}. Check the proxy version and connection.</p></Show>
      <button class="btn ghost" type="button" disabled={busy()} onClick={() => void clear()}>Delete archive and turn capture off</button>
    </section>
    <section class="card request-inspector">
      <div class="archive-filters">
        <label>Keywords <input value={query().text ?? ''} placeholder="Search captured text" onInput={(e) => filter('text', e.currentTarget.value)} /></label>
        <label>Provider <input value={query().provider ?? ''} onInput={(e) => filter('provider', e.currentTarget.value)} /></label>
        <label>Model <input value={query().model ?? ''} onInput={(e) => filter('model', e.currentTarget.value)} /></label>
        <label>Client <input value={query().client ?? ''} onInput={(e) => filter('client', e.currentTarget.value)} /></label>
        <label>Conversation <input value={query().sessionId ?? ''} onInput={(e) => filter('sessionId', e.currentTarget.value)} /></label>
        <label>From <input type="datetime-local" value={query().from ?? ''} onInput={(e) => filter('from', e.currentTarget.value)} /></label>
        <label>To <input type="datetime-local" value={query().to ?? ''} onInput={(e) => filter('to', e.currentTarget.value)} /></label>
        <label>State <select value={query().state ?? ''} onChange={(e) => filter('state', e.currentTarget.value as CaptureState)}><option value="">All</option><For each={['missing', 'pending', 'partial', 'complete', 'expired']}>{(s) => <option value={s}>{s}</option>}</For></select></label>
        <button class="btn ghost" type="button" disabled={busy()} onClick={() => void load(query())}>Refresh</button>
      </div>
      <Show when={error()}>{(e) => <p class="notice">{shownText(e())}</p>}</Show>
      <div class="archive-results"><For each={entries()} fallback={<p class="muted">No matching archive records. Historical requests have no capture identity.</p>}>{(r) => <button class="archive-result" type="button" onClick={() => setSelected(r.traceId)}>
        <span>{new Date(r.at).toLocaleString()} · {shownText(r.model || r.path || 'Unknown model')}</span><span class="badge">{r.state}</span><small>{shownText(r.sessionId ?? r.traceId)}</small>
      </button>}</For></div>
      <Show when={more()}><button class="btn ghost" type="button" disabled={busy()} onClick={() => void load({ ...query(), before: entries().at(-1)?.id }, true)}>Show more</button></Show>
    </section>
    <Show when={selected()}>{(trace) => <section class="card"><RequestInspector traceId={trace()} onConversation={(id) => setQuery({ sessionId: id })} /></section>}</Show>
  </div>;
}
