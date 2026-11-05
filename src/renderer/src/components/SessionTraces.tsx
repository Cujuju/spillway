import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { TraceAttempt, TraceCoverage, TraceNode, TraceQuery } from '@shared/sessionTrace';
import { transportRows } from '@shared/activityTransport';
import { shownText } from '../store';
import { compactNumber, dateTime, usd } from '../lib/format';
import { traceViewQuery } from '../lib/traceViewQuery';
import { RequestInspector } from './RequestInspector';
import '../styles/sessionTraces.css';

const localInput = (at: string | undefined) => at ? new Date(Date.parse(at) - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
const cost = (n: TraceNode) => n.metrics.costUsd === null ? 'Cost unavailable' : `${usd(n.metrics.costUsd)} known cost`;

function Attempt(props: { attempt: TraceAttempt; account: (id: string | null) => string; inspect: (id: string) => void }) {
  const a = () => props.attempt;
  return <article class="trace-attempt">
    <div class="card-spaced"><strong>{dateTime(a().at)} · {shownText(a().effectiveModel ?? a().model ?? 'Unknown model')}</strong>
      <span class="badge">{a().failed === true ? 'Failed attempt' : a().failed === false ? 'No failure reported' : 'Outcome unknown'}</span>
      <span class="badge">{a().origin === 'archive' ? 'Archive metadata' : a().source === 'client-log' ? 'Imported usage' : 'Proxy observation'}</span>
      <Show when={a().compactionEndpoint}><span class="badge">Compaction endpoint</span></Show>
    </div>
    <p>{a().costUsd === null ? 'Cost unavailable' : usd(a().costUsd!)} · {a().tokens ? `${compactNumber(a().tokens!.inputTokens)} input / ${compactNumber(a().tokens!.outputTokens)} output / ${compactNumber(a().tokens!.cachedTokens)} cache read / ${compactNumber(a().tokens!.cacheWriteTokens)} cache write` : 'Tokens unavailable'} · Effort {shownText(a().reasoningEffort ?? 'unknown')}</p>
    <p>{a().origin === 'archive' ? 'Account unavailable (archive-only link)' : shownText(props.account(a().authIndex))}
      <Show when={a().movedFrom}> · moved from {shownText(props.account(a().movedFrom))}</Show>
      {' · '}HTTP status {a().statusCode ?? 'unknown'} · latency {a().latencyMs === null ? 'unknown' : `${a().latencyMs} ms`} · first token {a().ttftMs === null ? 'unknown' : `${a().ttftMs} ms`}</p>
    <p class="trace-identity">Attempt {shownText(a().requestId)} · Selection {shownText(a().selectionId ?? 'unknown')}<br />Inbound trace {shownText(a().traceId ?? 'unknown')} · Capture {a().captureState} {shownText(a().captureReason)}</p>
    <details><summary>Observed transport and parent</summary>
      <For each={transportRows(a())}>{(r) => <p>{r.label}: {shownText(r.value)}</p>}</For>
      <p>Requested {shownText(a().model ?? 'unknown')} → effective {shownText(a().effectiveModel ?? 'unknown')} · {shownText(a().provider ?? 'Unknown provider')} · {shownText(a().client ?? 'Unknown client')}</p>
      <p class="trace-identity">Parent session: {shownText(a().parentSessionId ?? 'unknown')}</p>
    </details>
    <Show when={a().traceId}><button class="btn ghost" type="button" onClick={() => props.inspect(a().traceId!)}>Inspect captured exchange / tool payloads</button></Show>
  </article>;
}

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
    const timer = setTimeout(() => void load(q), 200);
    onCleanup(() => clearTimeout(timer));
  });
  onCleanup(() => { listGeneration++; attemptGeneration++; });
  const filter = (patch: Partial<TraceQuery>) => setQuery((q) => ({ ...q, ...patch, before: undefined }));
  const choose = (n: TraceNode) => { setSelected(n); setAttempts([]); setAttemptNext(null); setInspected(undefined); void loadAttempts(n, query()); };
  const navigate = (sessionId: string) => { setSessionInput(''); filter({ nodeId: `session:${sessionId}`, parentSessionId: undefined, text: undefined }); };
  const refresh = () => { const q = query(); setSelected(undefined); setInspected(undefined); attemptGeneration++; void load({ ...q, before: undefined }); };
  return <div class="trace-layout">
    <section class="card request-inspector">
      <h2>Session and subagent traces</h2>
      <p>Find expensive or failing branches using observed attempts. Every total belongs to this node alone; parent and child costs are never rolled together. Cost is a list-price estimate, not an invoice. “No failure reported” describes an attempt, not task completion.</p>
      <div class="archive-filters">
        <label>Find in read window <input placeholder="Session, model or effort" value={query().text ?? ''} onInput={(e) => filter({ text: e.currentTarget.value })} /></label>
        <label>Exact session <input placeholder="Enter a full session ID" value={sessionInput()} onInput={(e) => { setSessionInput(e.currentTarget.value); filter({ nodeId: e.currentTarget.value ? `session:${e.currentTarget.value}` : undefined, parentSessionId: undefined }); }} /></label>
        <label>Rank nodes <select value={query().sort} onChange={(e) => filter({ sort: e.currentTarget.value as TraceQuery['sort'] })}><option value="cost">Highest known cost</option><option value="failed">Most failed attempts</option><option value="recent">Most recent</option></select></label>
        <label>Usage <select value={query().source} onChange={(e) => filter({ source: e.currentTarget.value as TraceQuery['source'] })}><option value="proxy">Via proxy</option><option value="all">All reconciled usage</option></select></label>
        <label>From (blank = last 7 days) <input type="datetime-local" value={localInput(query().from)} onChange={(e) => filter({ from: e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : undefined })} /></label>
        <label>To (blank = live) <input type="datetime-local" value={localInput(query().to)} onChange={(e) => filter({ to: e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : undefined })} /></label>
        <button class="btn ghost" type="button" disabled={busy()} onClick={refresh}>Refresh</button>
        <button class="btn ghost" type="button" onClick={() => { setSessionInput(''); setQuery({ source: query().source, sort: query().sort }); }}>All sessions · latest 7 days</button>
      </div>
      <Show when={query().parentSessionId}><p>Direct children of <span class="trace-identity">{shownText(query().parentSessionId!)}</span>. Each child has its own cost.</p></Show>
      <Show when={query().nodeId}><p>Viewing exact node <span class="trace-identity">{shownText(query().nodeId!)}</span>. Enter a new full session ID above to replace it. <button class="btn ghost" type="button" onClick={() => { setSessionInput(''); filter({ nodeId: undefined }); }}>Clear exact node</button></p></Show>
      <Show when={coverage()}>{(c) => <p class="muted">{c().scanned.toLocaleString()} observations in this read window · {dateTime(c().from)} – {dateTime(c().to)} · {c().rejected} invalid links omitted. {c().limited ? `Limited to the newest ${c().limit.toLocaleString()} observations: rankings, counts, links and cycle detection are partial. Narrow dates or use an exact session.` : 'Counts cover retained observations in these dates, not the full lifetime of a conversation.'}</p>}</Show>
      <details><summary>Evidence and coverage limits</summary>
        <p>Parents come only from explicit proxy parent-session metadata. “Subagent” uses the supported claude:/codex: identity containing :agent:. Other parent relationships have unknown kind: forks and compactions cannot be distinguished from these fields. A captured /compact endpoint identifies only that request. Missing parent metadata never means a root session.</p>
        <p>Activity retention can remove attempts. Validated archive provenance keeps their session links, effort and transport navigable, but tokens, cost and account become unavailable here. Old archive links without provenance remain unassigned. Imports use Activity’s existing reconciliation; this view reads no client-log prompts. Body capture can be missing, partial or expired. Tool/delegation text is available only if observed in an explicitly opened capture; provider-hidden text is unavailable.</p>
        <p>Pages are a live read, not a frozen snapshot. Refresh after new observations or retention changes. Selection IDs connect attempts within a credential selection; request times order observations and do not prove causal order. Maximum date range: 90 days.</p>
      </details>
      <Show when={error()}>{(e) => <p class="notice">{shownText(e())}</p>}</Show>
    </section>
    <div class="trace-columns">
      <section class="card request-inspector">
        <h3>Branches · own usage</h3>
        <div class="trace-nodes" aria-busy={busy()}><For each={nodes()} fallback={<p class="muted">{busy() ? 'Loading traces…' : 'No matching retained observations. Narrow the range or search an exact session.'}</p>}>{(n) => <button type="button" class="trace-node" aria-pressed={selected()?.id === n.id} onClick={() => choose(n)}>
          <strong>{cost(n)} · {n.metrics.failed} failed attempts</strong>
          <span class="trace-identity">{shownText(n.sessionId ?? n.id)}</span>
          <span>{n.kind} · {n.metrics.attempts} attempts · {n.exchanges} known inbound exchanges · {n.metrics.tokens === null ? 'Tokens unavailable' : `${compactNumber(n.metrics.tokens)} known tokens`}</span>
          <span class="muted">{dateTime(n.lastAt)} · {n.metrics.missingUsage} usage unavailable · {n.metrics.unpriced} unpriced</span>
          <Show when={n.parents.some((p) => p.cycle) || n.conflictingParents}><span>Relationship warning: {n.conflictingParents ? 'conflicting parents' : 'cycle observed'}</span></Show>
        </button>}</For></div>
        <Show when={next()}><button class="btn ghost" type="button" disabled={busy()} onClick={() => void load({ ...query(), before: next()! }, true)}>More branches</button></Show>
      </section>
      <Show when={selected()} fallback={<section class="card request-inspector"><p class="muted">Select a branch to follow parents and children or inspect its requests.</p></section>}>{(n) => <section class="card request-inspector trace-detail">
        <h3>{n().kind === 'subagent' ? 'Subagent' : 'Session / exchange'} · own usage</h3>
        <p class="trace-identity">{shownText(n().sessionId ?? n().id)}</p>
        <p>{cost(n())} · {n().metrics.attempts} attempts · {n().metrics.failed} failures · {n().metrics.unknownOutcomes} unknown outcomes · {n().exchanges} known inbound exchanges · {n().attemptsWithoutTrace} attempts without trace identity</p>
        <p>{n().metrics.tokens === null ? 'Tokens unavailable' : `${compactNumber(n().metrics.tokens!)} known tokens`} · {n().metrics.missingUsage} usage unavailable · {n().metrics.unpriced} unpriced · {n().metrics.importedAttempts} imported attempts · {n().archiveOnly} archived-only links · {n().metrics.accountMoves} recorded account moves</p>
        <p>{dateTime(n().firstAt)} – {dateTime(n().lastAt)} · measured successful latency {n().metrics.latencyCount ? `${Math.round(n().metrics.latencySumMs / n().metrics.latencyCount)} ms (${n().metrics.latencyCount} samples)` : 'unknown'} · first token {n().metrics.ttftCount ? `${Math.round(n().metrics.ttftSumMs / n().metrics.ttftCount)} ms (${n().metrics.ttftCount} samples)` : 'unknown'}</p>
        <p>{shownText(n().models.join(', ') || 'Unknown model')} · Effort {shownText(n().efforts.join(', ') || 'unknown')}{n().dimensionsTruncated ? ' (first 12 values)' : ''}</p>
        <div class="trace-relations">
          <strong>Observed parent → this node</strong>
          <Show when={n().parents.length} fallback={<p class="muted">Parent unknown — no explicit parent evidence in this read window.</p>}>
            <Show when={n().conflictingParents}><p class="notice">Conflicting parent observations. No single ancestry is selected.</p></Show>
            <For each={n().parents}>{(p) => <div><button class="btn ghost trace-identity" type="button" onClick={() => navigate(p.sessionId)}>{shownText(p.sessionId)}</button> · {p.kind === 'subagent' ? 'subagent identity' : 'relationship kind unknown'} · {p.observed ? 'observed in read window' : 'parent not in read window'}{p.cycle ? ' · cycle; no causal ancestry inferred' : ''}</div>}</For>
            <Show when={n().parentCount > n().parents.length}><p class="muted">First {n().parents.length} of {n().parentCount} parent references shown.</p></Show>
          </Show>
          <Show when={n().sessionId}><button class="btn ghost" type="button" onClick={() => { setSessionInput(''); filter({ nodeId: undefined, text: undefined, parentSessionId: n().sessionId! }); }}>This node → browse direct children</button></Show>
        </div>
        <h3>Observable attempts · newest first</h3>
        <Show when={attemptError()}>{(e) => <p class="notice">{shownText(e())}</p>}</Show>
        <div aria-busy={attemptBusy()}><For each={attempts()} fallback={<p class="muted">{attemptBusy() ? 'Loading attempts…' : 'No retained attempts available in this range.'}</p>}>{(a) => <Attempt attempt={a} account={props.account} inspect={setInspected} />}</For></div>
        <Show when={attemptNext()}><button class="btn ghost" type="button" disabled={attemptBusy()} onClick={() => void loadAttempts(n(), query(), attemptNext()!)}>More attempts</button></Show>
      </section>}</Show>
    </div>
    <Show when={inspected()}>{(trace) => <section class="card"><RequestInspector traceId={trace()} onConversation={navigate} /></section>}</Show>
  </div>;
}
