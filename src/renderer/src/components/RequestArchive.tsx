import { FileArchive, RefreshCw } from 'lucide-solid';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { archiveCursor, DEFAULT_ARCHIVE_POLICY, type ArchiveEntry, type ArchivePolicy, type ArchiveQuery, type ArchiveStatus } from '@shared/archive';
import { DIAGNOSTIC_LIMITS } from '@shared/diagnosticBundle';
import { shownText } from '../store';
import { dateTime } from '../lib/format';
import { conversationLabel } from '../lib/conversationNames';
import { archiveViewQuery, RESET_ARCHIVE_FILTERS, type ArchiveFilters } from '../lib/archiveViewQuery';
import { createExchangeSteps, onRowActivate, REVEAL_ROW } from '../lib/exchangeNav';
import { persistedSignal } from '../lib/persisted';
import { CAPTURE_LABEL, CAPTURE_TONE, EXCHANGE_LAYOUT_OPTIONS, EXCHANGE_LAYOUTS, type ExchangeLayout } from '../lib/traceFormat';
import type { TraceWindow } from '../lib/traceViewQuery';
import { CaptureMenu, CaptureStatus } from './ArchiveCapture';
import { ArchiveExport } from './ArchiveExport';
import { DiagnosticBundle } from './DiagnosticBundle';
import { EvalCases } from './EvalCases';
import { HoverTip } from './ChartTip';
import { RequestInspector } from './RequestInspector';
import { Seg } from './ui';
import '../styles/archive.css';

const ICON_PX = 14;
/** Typing settles before a query runs. */
const QUERY_DEBOUNCE_MS = 200;
/** Store health (drops, bytes) changes as traffic arrives. */
const STATUS_REFRESH_MS = 3_000;
/** Columns in a record row; an inline exchange spans them all. */
const COLUMNS = 5;

function RecordRow(props: { r: ArchiveEntry; open: boolean; picked: boolean; full: boolean; onToggle: () => void; onPick: (on: boolean) => void }) {
  const r = () => props.r;
  let row: HTMLTableRowElement | undefined;
  createEffect(() => { if (props.open) row?.scrollIntoView(REVEAL_ROW); });
  return (
    <tr ref={row} class="inspectable" classList={{ selected: props.open }} tabIndex={0} aria-expanded={props.open}
      onClick={() => props.onToggle()} onKeyDown={(e) => onRowActivate(e, () => props.onToggle())}>
      <td class="col-check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label="Add to diagnostic bundle" checked={props.picked} disabled={props.full && !props.picked} onChange={(e) => props.onPick(e.currentTarget.checked)} />
      </td>
      <td class="tabular">{dateTime(r().at)}</td>
      <td class="fill">{shownText(r().model || r().path || '—')}</td>
      <td class="fill">
        <HoverTip title="Conversation" rows={[{ label: 'ID', value: shownText(r().sessionId ?? '—') }, { label: 'Trace', value: shownText(r().traceId) }]}>
          <span>{r().sessionId ? shownText(conversationLabel(r().sessionId!)) : <span class="muted">—</span>}</span>
        </HoverTip>
      </td>
      <td><span class={`badge compact ${CAPTURE_TONE[r().state]}`}>{CAPTURE_LABEL[r().state]}</span></td>
    </tr>
  );
}

/** Captured exchanges. Filters and the time frame come from the page's scope sentence; clicking a row opens its exchange. */
export function RequestArchive(props: { filters: ArchiveFilters; window: TraceWindow; onFilters: (patch: Partial<ArchiveFilters>) => void }) {
  const [layout, setLayout] = persistedSignal<ExchangeLayout>('activity.exchangeLayout', 'panel', EXCHANGE_LAYOUTS);
  const [status, setStatus] = createSignal<ArchiveStatus & { syncError?: string | null }>();
  /** The query behind the listed records, so pages and exports match what is shown. */
  const [shown, setShown] = createSignal<ArchiveQuery>({});
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
      if (!append) setShown(q);
    } catch (e) { if (gen === generation) setError(String(e)); }
    finally { if (gen === generation) setBusy(false); }
  };
  const reload = () => load(archiveViewQuery(props.filters, props.window));
  createEffect(() => {
    const q = archiveViewQuery(props.filters, props.window);
    const timer = setTimeout(() => void load(q), QUERY_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });
  onMount(() => {
    const timer = setInterval(() => { void window.api.archiveStatus().then(setStatus).catch((e) => setError(String(e))); }, STATUS_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });
  const policy = () => status()?.policy ?? DEFAULT_ARCHIVE_POLICY;
  const save = async (p: ArchivePolicy) => {
    setBusy(true); setError(null);
    try { setStatus(await window.api.archivePolicy(p)); await reload(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try { await window.api.archiveClear(); setSelected(undefined); await reload(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const picked = (id: string) => bundleSelection().includes(id);
  const full = () => bundleSelection().length >= DIAGNOSTIC_LIMITS.records;
  const pick = (id: string, on: boolean) => setBundleSelection((old) => on ? [...old, id] : old.filter((x) => x !== id));

  const toggle = (id: string) => setSelected((old) => (old === id ? undefined : id));
  const step = createExchangeSteps(createMemo(() => entries().map((r) => r.traceId)), selected, setSelected);
  const exchange = (traceId: string) => (
    <RequestInspector traceId={traceId} step={step()} onClose={() => setSelected(undefined)}
      onConversation={(sessionId) => props.onFilters({ ...RESET_ARCHIVE_FILTERS, sessionId })} />
  );

  return <div class="inspect archive-view">
    <section class="card archive-records">
      <div class="panel-head">
        <h2 class="card-title">Records</h2>
        <span class="panel-count">{entries().length.toLocaleString()}{more() ? '+' : ''}</span>
        <Show when={status()}>{(s) => <CaptureStatus status={s()} />}</Show>
        <div class="panel-head-end">
          <Show when={bundleSelection().length}>
            <span class="panel-count">{bundleSelection().length} / {DIAGNOSTIC_LIMITS.records} selected</span>
            <button class="btn ghost" type="button" onClick={() => setBundleSelection([])}>Clear</button>
            <button class="btn" type="button" onClick={() => setBundle([...bundleSelection()])}><FileArchive size={ICON_PX} />Diagnostic bundle</button>
          </Show>
          <Seg label="Open exchanges" value={layout()} options={EXCHANGE_LAYOUT_OPTIONS} onChange={setLayout} />
          <CaptureMenu policy={policy()} busy={busy()} onSave={(p) => void save(p)} onClear={() => void clear()} />
          <button class="btn icon-btn ghost" type="button" title="Refresh" aria-label="Refresh" disabled={busy()} onClick={() => void reload()}><RefreshCw size={ICON_PX} /></button>
        </div>
      </div>
      <Show when={error()}>{(e) => <p class="notice error inspect-notice">{shownText(e())}</p>}</Show>
      <Show when={status()?.syncError}>{(e) => <p class="notice error inspect-notice">Capture sync failed: {shownText(e())}</p>}</Show>
      <Show when={status()?.exportWarning}>{(w) => <p class="notice inspect-notice">Export cleanup: {shownText(w())}</p>}</Show>
      <div class="archive-list">
        <div class="archive-table">
          <table class="table dense">
            <thead><tr><th class="col-check" /><th>Time</th><th>Model</th><th>Conversation</th><th>Capture</th></tr></thead>
            <tbody aria-busy={busy()}>
              <For each={entries()} fallback={<tr><td class="empty-row" colSpan={COLUMNS}>{busy() ? 'Loading…' : 'No records match.'}</td></tr>}>{(r) => {
                const open = () => selected() === r.traceId;
                return <>
                  <RecordRow r={r} open={open()} picked={picked(r.traceId)} full={full()} onToggle={() => toggle(r.traceId)} onPick={(on) => pick(r.traceId, on)} />
                  <Show when={open() && layout() === 'inline'}><tr class="row-exchange"><td colSpan={COLUMNS}>{exchange(r.traceId)}</td></tr></Show>
                </>;
              }}</For>
            </tbody>
          </table>
        </div>
        <Show when={layout() === 'panel' && selected()}>{(trace) => <aside class="card exchange-panel" aria-label="Exchange">{exchange(trace())}</aside>}</Show>
      </div>
      <Show when={more()}><button class="btn ghost list-more" type="button" disabled={busy()} onClick={() => { const last = entries().at(-1); if (last) void load({ ...shown(), before: archiveCursor(last) }, true); }}>Load more</button></Show>
    </section>
    <ArchiveExport query={shown()} traceId={selected()} />
    <EvalCases traceId={selected()} />
    <Show when={bundle()}>{(ids) => <DiagnosticBundle traceIds={ids()} onClose={() => setBundle(undefined)} />}</Show>
  </div>;
}
