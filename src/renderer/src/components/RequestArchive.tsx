import { FileArchive, RefreshCw } from 'lucide-solid';
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { archiveCursor, DEFAULT_ARCHIVE_POLICY, type ArchiveEntry, type ArchivePolicy, type ArchiveQuery, type ArchiveStatus, type CaptureState } from '@shared/archive';
import { DIAGNOSTIC_LIMITS } from '@shared/diagnosticBundle';
import { shownText } from '../store';
import { dateTime } from '../lib/format';
import { conversationLabel } from '../lib/conversationNames';
import { CAPTURE_LABEL, CAPTURE_TONE } from '../lib/traceFormat';
import { ArchiveCapture } from './ArchiveCapture';
import { ArchiveExport } from './ArchiveExport';
import { DiagnosticBundle } from './DiagnosticBundle';
import { EvalCases } from './EvalCases';
import { HoverTip } from './ChartTip';
import { RequestInspector } from './RequestInspector';
import '../styles/archive.css';

const ICON_PX = 14;
/** Typing settles before a query runs. */
const QUERY_DEBOUNCE_MS = 200;
/** Store health (drops, bytes) changes as traffic arrives. */
const STATUS_REFRESH_MS = 3_000;
const STATES: readonly CaptureState[] = ['complete', 'partial', 'pending', 'missing', 'expired'];
const TEXT_FILTERS = [['provider', 'Provider'], ['model', 'Model'], ['client', 'Client'], ['sessionId', 'Conversation']] as const;

export function RequestArchive() {
  const [status, setStatus] = createSignal<ArchiveStatus & { syncError?: string | null }>();
  const [query, setQuery] = createSignal<ArchiveQuery>({});
  const [entries, setEntries] = createSignal<ArchiveEntry[]>([]);
  const [more, setMore] = createSignal(false);
  const [selected, setSelected] = createSignal<string>();
  const [bundleSelection, setBundleSelection] = createSignal<string[]>([]);
  const [bundle, setBundle] = createSignal<string[]>();
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
  createEffect(() => { const q = query(); const timer = setTimeout(() => void load(q), QUERY_DEBOUNCE_MS); onCleanup(() => clearTimeout(timer)); });
  onMount(() => {
    const timer = setInterval(() => { void window.api.archiveStatus().then(setStatus).catch((e) => setError(String(e))); }, STATUS_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });
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
  const picked = (id: string) => bundleSelection().includes(id);
  const full = () => bundleSelection().length >= DIAGNOSTIC_LIMITS.records;
  const toggle = (id: string, on: boolean) => setBundleSelection((old) => on ? [...old, id] : old.filter((x) => x !== id));

  return <div class="inspect">
    <ArchiveCapture status={status()} policy={policy()} busy={busy()} onSave={(p) => void save(p)} onClear={() => void clear()} />
    <section class="card">
      <div class="panel-head">
        <h2 class="card-title">Records</h2>
        <span class="panel-count">{entries().length.toLocaleString()}{more() ? '+' : ''}</span>
        <div class="panel-head-end">
          <Show when={bundleSelection().length}>
            <span class="panel-count">{bundleSelection().length} / {DIAGNOSTIC_LIMITS.records} selected</span>
            <button class="btn ghost" type="button" onClick={() => setBundleSelection([])}>Clear</button>
            <button class="btn" type="button" onClick={() => setBundle([...bundleSelection()])}><FileArchive size={ICON_PX} />Diagnostic bundle</button>
          </Show>
          <button class="btn icon-btn ghost" type="button" title="Refresh" aria-label="Refresh" disabled={busy()} onClick={() => void load(query())}><RefreshCw size={ICON_PX} /></button>
        </div>
      </div>
      <div class="filter-bar">
        <input class="input filter-grow" type="search" placeholder="Search captured text" aria-label="Search captured text" value={query().text ?? ''} onInput={(e) => filter('text', e.currentTarget.value)} />
        <For each={TEXT_FILTERS}>{([key, label]) => <input class="input filter-narrow" placeholder={label} aria-label={label} value={query()[key] ?? ''} onInput={(e) => filter(key, e.currentTarget.value)} />}</For>
        <select class="select" aria-label="Capture state" value={query().state ?? ''} onChange={(e) => filter('state', e.currentTarget.value)}>
          <option value="">Any state</option>
          <For each={STATES}>{(s) => <option value={s}>{CAPTURE_LABEL[s]}</option>}</For>
        </select>
        <span class="date-range">
          <input class="input" type="datetime-local" aria-label="From" title="From" value={query().from ?? ''} onInput={(e) => filter('from', e.currentTarget.value)} />
          <span aria-hidden="true">–</span>
          <input class="input" type="datetime-local" aria-label="To" title="To" value={query().to ?? ''} onInput={(e) => filter('to', e.currentTarget.value)} />
        </span>
      </div>
      <Show when={error()}>{(e) => <p class="notice error inspect-notice">{shownText(e())}</p>}</Show>
      <div class="archive-table">
        <table class="table dense">
          <thead><tr><th class="col-check" /><th>Time</th><th>Model</th><th>Conversation</th><th>Capture</th></tr></thead>
          <tbody aria-busy={busy()}>
            <For each={entries()} fallback={<tr><td class="empty-row" colSpan={5}>{busy() ? 'Loading…' : 'No records match.'}</td></tr>}>{(r) => (
              <tr classList={{ selected: selected() === r.traceId }} onClick={() => setSelected(r.traceId)}>
                <td class="col-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label="Add to diagnostic bundle" checked={picked(r.traceId)} disabled={full() && !picked(r.traceId)} onChange={(e) => toggle(r.traceId, e.currentTarget.checked)} />
                </td>
                <td class="tabular"><button class="sort-btn" type="button" aria-pressed={selected() === r.traceId} onClick={(e) => { e.stopPropagation(); setSelected(r.traceId); }}>{dateTime(r.at)}</button></td>
                <td class="fill">{shownText(r.model || r.path || '—')}</td>
                <td class="fill">
                  <HoverTip title="Conversation" rows={[{ label: 'ID', value: shownText(r.sessionId ?? '—') }, { label: 'Trace', value: shownText(r.traceId) }]}>
                    <span>{r.sessionId ? shownText(conversationLabel(r.sessionId)) : <span class="muted">—</span>}</span>
                  </HoverTip>
                </td>
                <td><span class={`badge compact ${CAPTURE_TONE[r.state]}`}>{CAPTURE_LABEL[r.state]}</span></td>
              </tr>
            )}</For>
          </tbody>
        </table>
      </div>
      <Show when={more()}><button class="btn ghost list-more" type="button" disabled={busy()} onClick={() => { const last = entries().at(-1); if (last) void load({ ...query(), before: archiveCursor(last) }, true); }}>Load more</button></Show>
    </section>
    <Show when={selected()}>{(trace) => <section class="card"><RequestInspector traceId={trace()} onConversation={(id) => setQuery({ sessionId: id })} onClose={() => setSelected(undefined)} /></section>}</Show>
    <ArchiveExport query={query()} traceId={selected()} />
    <EvalCases traceId={selected()} />
    <Show when={bundle()}>{(ids) => <DiagnosticBundle traceIds={ids()} onClose={() => setBundle(undefined)} />}</Show>
  </div>;
}
