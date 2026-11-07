import { X } from 'lucide-solid';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import type { TraceAttempt, TraceCoverage, TraceNode, TraceQuery } from '@shared/sessionTrace';
import { shownText } from '../store';
import { conversationLabel } from '../lib/conversationNames';
import { traceViewQuery } from '../lib/traceViewQuery';
import { RequestInspector } from './RequestInspector';
import { TraceBranches } from './TraceBranches';
import { TraceDetail } from './TraceDetail';
import { Seg } from './ui';
import '../styles/archive.css';
import '../styles/sessionTraces.css';

const ICON_PX = 14;
/** Typing settles before a query runs. */
const QUERY_DEBOUNCE_MS = 200;
const SORTS = [{ value: 'cost', label: 'Cost' }, { value: 'failed', label: 'Failures' }, { value: 'recent', label: 'Recent' }] as const;
const SOURCES = [{ value: 'proxy', label: 'Via proxy' }, { value: 'all', label: 'All usage' }] as const;

const localInput = (at: string | undefined) => at ? new Date(Date.parse(at) - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
const fromLocal = (value: string) => (value ? new Date(value).toISOString() : undefined);

export function SessionTraces(props: { account: (id: string | null) => string }) {
  const [query, setQuery] = createSignal<TraceQuery>({ sort: 'cost', source: 'proxy' });
  const [sessionInput, setSessionInput] = createSignal('');
  const [nodes, setNodes] = createSignal<TraceNode[]>([]), [coverage, setCoverage] = createSignal<TraceCoverage>();
  const [next, setNext] = createSignal<string | null>(null), [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null), [selected, setSelected] = createSignal<TraceNode>();
  const [attempts, setAttempts] = createSignal<TraceAttempt[]>([]), [attemptNext, setAttemptNext] = createSignal<string | null>(null);
  const [attemptBusy, setAttemptBusy] = createSignal(false), [attemptError, setAttemptError] = createSignal<string | null>(null);
  const [inspected, setInspected] = createSignal<string>();
  let listGeneration = 0, attemptGeneration = 0;
  const load = async (q: TraceQuery, append = false) => {
    const gen = ++listGeneration; setBusy(true); setError(null);
    try {
      const page = await window.api.traceQuery(traceViewQuery(q, append ? coverage() : undefined));
      if (gen !== listGeneration) return;
      setNodes((old) => append ? [...old, ...page.nodes] : page.nodes); setNext(page.next); setCoverage(page.coverage);
    } catch (e) { if (gen === listGeneration) setError(String(e)); }
    finally { if (gen === listGeneration) setBusy(false); }
  };
  const loadAttempts = async (node: TraceNode, q: TraceQuery, before?: string) => {
    const gen = ++attemptGeneration; setAttemptBusy(true); setAttemptError(null);
    try {
      const bounds = traceViewQuery(q, coverage());
      const page = await window.api.traceAttempts({ nodeId: node.id, from: bounds.from, to: bounds.to, source: q.source, before });
      if (gen !== attemptGeneration) return;
      setAttempts((old) => before ? [...old, ...page.attempts] : page.attempts); setAttemptNext(page.next);
    } catch (e) { if (gen === attemptGeneration) setAttemptError(String(e)); }
    finally { if (gen === attemptGeneration) setAttemptBusy(false); }
  };
  createEffect(() => {
    const q = query();
    // Invalidate pending replies immediately, including during the search debounce.
    listGeneration++; attemptGeneration++; setSelected(undefined); setAttempts([]); setInspected(undefined);
    setNodes([]); setNext(null); setCoverage(undefined); setBusy(true);
    const timer = setTimeout(() => void load(q), QUERY_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });
  onCleanup(() => { listGeneration++; attemptGeneration++; });
  const filter = (patch: Partial<TraceQuery>) => setQuery((q) => ({ ...q, ...patch, before: undefined }));
  const choose = (n: TraceNode) => { setSelected(n); setAttempts([]); setAttemptNext(null); setInspected(undefined); void loadAttempts(n, query()); };
  const navigate = (sessionId: string) => { setSessionInput(''); filter({ nodeId: `session:${sessionId}`, parentSessionId: undefined, text: undefined }); };
  const refresh = () => { const q = query(); setSelected(undefined); setInspected(undefined); attemptGeneration++; void load({ ...q, before: undefined }); };
  const clearNode = () => { setSessionInput(''); filter({ nodeId: undefined }); };
  const nodeName = (id: string) => (id.startsWith('session:') ? conversationLabel(id.slice('session:'.length)) : id);

  return <div class="inspect">
    <section class="card">
      <div class="filter-bar">
        <input class="input filter-grow" type="search" placeholder="Search sessions, models, effort" aria-label="Search" value={query().text ?? ''} onInput={(e) => filter({ text: e.currentTarget.value })} />
        <input class="input filter-narrow" placeholder="Exact session ID" aria-label="Exact session ID" value={sessionInput()} onInput={(e) => { setSessionInput(e.currentTarget.value); filter({ nodeId: e.currentTarget.value ? `session:${e.currentTarget.value}` : undefined, parentSessionId: undefined }); }} />
        <Seg label="Rank by" value={query().sort ?? 'cost'} options={SORTS} onChange={(sort) => filter({ sort })} />
        <Seg label="Usage" value={query().source ?? 'proxy'} options={SOURCES} onChange={(source) => filter({ source })} />
        <span class="date-range">
          <input class="input" type="datetime-local" aria-label="From" title="From (blank: 7 days ago)" value={localInput(query().from)} onChange={(e) => filter({ from: fromLocal(e.currentTarget.value) })} />
          <span aria-hidden="true">–</span>
          <input class="input" type="datetime-local" aria-label="To" title="To (blank: now)" value={localInput(query().to)} onChange={(e) => filter({ to: fromLocal(e.currentTarget.value) })} />
        </span>
      </div>
      <div class="filter-foot">
        <Show when={query().parentSessionId}>{(id) => (
          <span class="chip"><span class="chip-label">Children of</span><span class="chip-value">{shownText(conversationLabel(id()))}</span>
            <button class="chip-btn" type="button" aria-label="Clear" onClick={() => filter({ parentSessionId: undefined })}><X size={ICON_PX} /></button></span>
        )}</Show>
        <Show when={query().nodeId}>{(id) => (
          <span class="chip"><span class="chip-label">Session</span><span class="chip-value">{shownText(nodeName(id()))}</span>
            <button class="chip-btn" type="button" aria-label="Clear" onClick={clearNode}><X size={ICON_PX} /></button></span>
        )}</Show>
      </div>
      <Show when={coverage()?.limited}><p class="notice inspect-notice">Showing the newest {coverage()!.limit.toLocaleString()} requests only. Narrow the dates or pick one session for complete totals.</p></Show>
      <Show when={error()}>{(e) => <p class="notice error inspect-notice">{shownText(e())}</p>}</Show>
    </section>

    <div class="trace-columns">
      <TraceBranches coverage={coverage()} onRefresh={refresh} nodes={nodes()} busy={busy()} more={!!next()} selected={selected()?.id} onSelect={choose} onMore={() => void load({ ...query(), before: next()! }, true)} />
      <Show when={selected()} fallback={<section class="card"><p class="empty">Select a branch to see its requests and parent links.</p></section>}>{(n) => (
        <TraceDetail n={n()} attempts={attempts()} busy={attemptBusy()} more={!!attemptNext()} error={attemptError()} account={props.account}
          onInspect={setInspected} onNavigate={navigate} onMore={() => void loadAttempts(n(), query(), attemptNext()!)}
          onChildren={(id) => { setSessionInput(''); filter({ nodeId: undefined, text: undefined, parentSessionId: id }); }} />
      )}</Show>
    </div>
    <Show when={inspected()}>{(trace) => <section class="card"><RequestInspector traceId={trace()} onConversation={navigate} onClose={() => setInspected(undefined)} /></section>}</Show>
  </div>;
}
