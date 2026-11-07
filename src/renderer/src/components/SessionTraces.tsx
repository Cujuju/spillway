import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import type { TraceAttempt, TraceCoverage, TraceNode, TraceQuery, TraceSource } from '@shared/sessionTrace';
import { shownText } from '../store';
import { persistedSignal } from '../lib/persisted';
import { traceViewQuery, type TraceWindow } from '../lib/traceViewQuery';
import { EXCHANGE_LAYOUTS, type ExchangeLayout } from '../lib/traceFormat';
import { RequestInspector } from './RequestInspector';
import { TraceBranches } from './TraceBranches';
import { TraceDetail } from './TraceDetail';
import { sessionNode, type TraceFilters } from './TraceScopeParts';
import '../styles/archive.css';
import '../styles/sessionTraces.css';

/** Typing settles before a query runs. */
const QUERY_DEBOUNCE_MS = 200;
/** Keys that step through or close the open exchange; typing in a field keeps them. */
const STEP_KEYS: Record<string, -1 | 1> = { ArrowUp: -1, ArrowDown: 1 };
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Filters, usage source and time frame come from the page's scope sentence. */
export function SessionTraces(props: {
  account: (id: string | null) => string; source: TraceSource; window: TraceWindow;
  filters: TraceFilters; onFilters: (patch: Partial<TraceFilters>) => void;
}) {
  const query = createMemo<TraceQuery>(() => ({ ...props.filters, source: props.source }));
  const [layout, setLayout] = persistedSignal<ExchangeLayout>('activity.exchangeLayout', 'panel', EXCHANGE_LAYOUTS);
  const [nodes, setNodes] = createSignal<TraceNode[]>([]), [coverage, setCoverage] = createSignal<TraceCoverage>();
  const [next, setNext] = createSignal<string | null>(null), [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null), [selected, setSelected] = createSignal<TraceNode>();
  const [attempts, setAttempts] = createSignal<TraceAttempt[]>([]), [attemptNext, setAttemptNext] = createSignal<string | null>(null);
  const [attemptBusy, setAttemptBusy] = createSignal(false), [attemptError, setAttemptError] = createSignal<string | null>(null);
  const [inspected, setInspected] = createSignal<string>();
  let listGeneration = 0, attemptGeneration = 0;
  const load = async (q: TraceQuery, frame: TraceWindow, before?: string) => {
    const gen = ++listGeneration; setBusy(true); setError(null);
    try {
      const page = await window.api.traceQuery({ ...traceViewQuery(q, frame, before ? coverage() : undefined), before });
      if (gen !== listGeneration) return;
      setNodes((old) => before ? [...old, ...page.nodes] : page.nodes); setNext(page.next); setCoverage(page.coverage);
    } catch (e) { if (gen === listGeneration) setError(String(e)); }
    finally { if (gen === listGeneration) setBusy(false); }
  };
  const loadAttempts = async (node: TraceNode, q: TraceQuery, before?: string) => {
    const gen = ++attemptGeneration; setAttemptBusy(true); setAttemptError(null);
    try {
      const bounds = traceViewQuery(q, props.window, coverage());
      const page = await window.api.traceAttempts({ nodeId: node.id, from: bounds.from, to: bounds.to, source: q.source, before });
      if (gen !== attemptGeneration) return;
      setAttempts((old) => before ? [...old, ...page.attempts] : page.attempts); setAttemptNext(page.next);
    } catch (e) { if (gen === attemptGeneration) setAttemptError(String(e)); }
    finally { if (gen === attemptGeneration) setAttemptBusy(false); }
  };
  createEffect(() => {
    const q = query(), frame = props.window;
    // Invalidate pending replies immediately, including during the search debounce.
    listGeneration++; attemptGeneration++; setSelected(undefined); setAttempts([]); setInspected(undefined);
    setNodes([]); setNext(null); setCoverage(undefined); setBusy(true);
    const timer = setTimeout(() => void load(q, frame), QUERY_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });
  onCleanup(() => { listGeneration++; attemptGeneration++; });
  const choose = (n: TraceNode) => { setSelected(n); setAttempts([]); setAttemptNext(null); setInspected(undefined); void loadAttempts(n, query()); };
  const navigate = (sessionId: string) => props.onFilters({ nodeId: sessionNode(sessionId), parentSessionId: undefined, text: undefined });
  const refresh = () => { setSelected(undefined); setInspected(undefined); attemptGeneration++; void load(query(), props.window); };

  // The open exchange steps through the attempts that have one.
  const inspectable = createMemo(() => attempts().flatMap((a) => (a.traceId ? [a.traceId] : [])));
  const position = createMemo(() => inspectable().indexOf(inspected() ?? ''));
  const step = (delta: -1 | 1) => { const id = inspectable()[position() + delta]; if (id) setInspected(id); };
  createEffect(() => {
    if (!inspected()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || typing(e.target)) return;
      if (e.key === 'Escape') { setInspected(undefined); return; }
      const delta = STEP_KEYS[e.key];
      if (delta) { e.preventDefault(); step(delta); }
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => document.removeEventListener('keydown', onKey));
  });
  const exchange = (traceId: string) => (
    <RequestInspector traceId={traceId} onConversation={navigate} onClose={() => setInspected(undefined)}
      step={{ index: position(), count: inspectable().length, onStep: step }} />
  );

  return <div class="inspect trace-view">
    <Show when={coverage()?.limited}><p class="notice">Showing the newest {coverage()!.limit.toLocaleString()} requests only. Narrow the time frame or pick one session for complete totals.</p></Show>
    <Show when={error()}>{(e) => <p class="notice error">{shownText(e())}</p>}</Show>
    <div class="trace-columns">
      <TraceBranches coverage={coverage()} onRefresh={refresh} nodes={nodes()} busy={busy()} more={!!next()} selected={selected()?.id} onSelect={choose} onMore={() => void load(query(), props.window, next()!)} />
      <Show when={selected()} fallback={<section class="card"><p class="empty-note">Select a branch to see its requests and parent links.</p></section>}>{(n) => (
        <TraceDetail n={n()} attempts={attempts()} busy={attemptBusy()} more={!!attemptNext()} error={attemptError()} account={props.account}
          inspected={inspected()} layout={layout()} onLayout={setLayout} exchange={layout() === 'inline' ? exchange : undefined}
          onInspect={(id) => setInspected((old) => (old === id ? undefined : id))} onNavigate={navigate} onMore={() => void loadAttempts(n(), query(), attemptNext()!)}
          onChildren={(id) => props.onFilters({ nodeId: undefined, text: undefined, parentSessionId: id })} />
      )}</Show>
      <Show when={layout() === 'panel' && inspected()}>{(trace) => <aside class="card exchange-panel" aria-label="Exchange">{exchange(trace())}</aside>}</Show>
    </div>
  </div>;
}
