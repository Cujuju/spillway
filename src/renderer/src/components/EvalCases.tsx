import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { EvalAnnotation, EvalCase, EvalCaseSummary, EvalExportPreview, EvalReplayPreview, EvalReplayResult } from '@shared/evalCase';
import { shownText } from '../store';

const blank = (): EvalAnnotation => ({ title: '', notes: '', expectedOutcome: '', assertions: [], context: { repository: '', revision: '', workspace: 'unknown', notes: '' } });
export function EvalCases(props: { traceId?: string }) {
  const [list, setList] = createSignal<EvalCaseSummary[]>([]);
  const [selected, setSelected] = createSignal<EvalCase>();
  const [draft, setDraft] = createSignal(blank());
  const [assertions, setAssertions] = createSignal('[]');
  const [bodies, setBodies] = createSignal(false);
  const [exportBodies, setExportBodies] = createSignal(false);
  const [preview, setPreview] = createSignal<EvalExportPreview>();
  const [replay, setReplay] = createSignal<EvalReplayPreview>();
  const [result, setResult] = createSignal<EvalReplayResult>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [message, setMessage] = createSignal<string>();
  let disposed = false, polling = false;
  const refresh = async () => { const rows = await window.api.evalList(); if (!disposed) setList(rows); };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(undefined); setMessage(undefined);
    try { await fn(); } catch (e) { if (!disposed) setError(String(e)); } finally { if (!disposed) setBusy(false); }
  };
  onMount(() => void run(refresh));
  const forget = async () => {
    const r = replay(); if (r) await window.api.evalReplayCancel(r.id);
    await window.api.evalExportDiscard(); setPreview(undefined); setReplay(undefined); setResult(undefined);
  };
  const choose = async (id: string, revision?: number) => {
    await forget(); const c = await window.api.evalGet(id, revision); if (disposed) return;
    setSelected(c); setDraft(c.annotation); setAssertions(JSON.stringify(c.annotation.assertions, null, 2));
  };
  const annotation = (): EvalAnnotation => ({ ...draft(), assertions: JSON.parse(assertions()) as EvalAnnotation['assertions'] });
  const save = async () => {
    const c = selected(); await forget();
    const saved = c ? await window.api.evalRevise(c.id, c.revision, annotation()) : await window.api.evalCreate(props.traceId!, annotation(), bodies());
    setSelected(saved); setDraft(saved.annotation); await refresh();
  };
  const prepareReplay = async () => {
    const c = selected(); if (!c) return; await forget();
    const p = await window.api.evalReplayPrepare(c.id, c.revision);
    if (disposed) await window.api.evalReplayCancel(p.id); else setReplay(p);
  };
  const timer = setInterval(() => {
    const r = replay(); if (!r || polling || result()?.state !== 'running') return;
    polling = true;
    void window.api.evalReplayStatus(r.id).then((next) => { if (!disposed && replay()?.id === next.id) setResult(next); })
      .catch((e) => { if (!disposed) setError(String(e)); }).finally(() => { polling = false; });
  }, 400);
  onCleanup(() => { disposed = true; clearInterval(timer); void forget().catch((e) => console.error('Eval preview cleanup failed', e)); });
  const field = (key: 'title' | 'notes' | 'expectedOutcome', value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const context = (key: 'repository' | 'revision' | 'notes', value: string) => setDraft((d) => ({ ...d, context: { ...d.context, [key]: value } }));
  return <section class="card request-inspector eval-cases">
    <h2>Durable eval cases</h2>
    <p>Supported replay: self-contained text-only HTTP POST /v1/chat/completions and /v1/messages. Responses/Codex, WebSocket, tools, tool results, attachments and stateful context remain inspectable protocol snapshots with replay unsupported. Full agent-task replay needs a reproducible repository/tool environment and an agent harness, which this app does not provide.</p>
    <p>Cases are pinned encrypted snapshots, independent of archive expiry and archive deletion. Each edit creates an immutable revision. Limits: 200 cases, 8 revisions and 8 MiB per case, 4 MiB per snapshot, 64 MiB total. At capacity, additions fail; delete cases explicitly. Delete all Activity also deletes all cases.</p>
    <div class="archive-filters">
      <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(async () => { await forget(); setSelected(undefined); setDraft(blank()); setAssertions('[]'); })}>New from selected capture</button>
      <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(async () => { const rows = await window.api.evalImport(); await refresh(); setMessage(`Imported ${rows.length} case revisions. Imports never execute.`); })}>Import cases / portable archive…</button>
      <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(refresh)}>Refresh cases</button>
    </div>
    <div class="archive-results"><For each={list()}>{(c) => <button class="archive-result" type="button" disabled={busy()} onClick={() => void run(() => choose(c.id))}><span>{shownText(c.title)} · revision {c.revision}</span><small>{c.id}</small></button>}</For></div>
    <p>{selected() ? `${selected()!.id} · revision ${selected()!.revision}` : `New snapshot source: ${props.traceId ?? 'select an archive capture first'}`}</p>
    <div class="archive-filters">
      <label>Title <input maxLength={160} value={draft().title} onInput={(e) => field('title', e.currentTarget.value)} /></label>
      <label>Repository label (unverified) <input value={draft().context.repository} onInput={(e) => context('repository', e.currentTarget.value)} /></label>
      <label>Revision label (unverified) <input value={draft().context.revision} onInput={(e) => context('revision', e.currentTarget.value)} /></label>
    </div>
    <label>Annotations <textarea rows="2" value={draft().notes} onInput={(e) => field('notes', e.currentTarget.value)} /></label>
    <label>Expected outcome (human review; never executed) <textarea rows="2" value={draft().expectedOutcome} onInput={(e) => field('expectedOutcome', e.currentTarget.value)} /></label>
    <label>Missing workspace/tool/context notes <textarea rows="2" value={draft().context.notes} onInput={(e) => context('notes', e.currentTarget.value)} /></label>
    <label>Literal assertions (JSON array; kinds: contains, not-contains, equals) <textarea rows="3" spellcheck={false} value={assertions()} placeholder={'[{"kind":"contains","value":"expected text"}]'} onInput={(e) => setAssertions(e.currentTarget.value)} /></label>
    <p class="muted">Assertions compare exact, case-sensitive model output text. No regex, scripts, shell commands or repository checks run. All assertions must pass. HTTP success and passing text assertions leave task outcome unknown.</p>
    <Show when={!selected()}><label><input type="checkbox" checked={bodies()} onChange={(e) => setBodies(e.currentTarget.checked)} /> Pin previously recorded protocol bodies with this case (may contain private text)</label></Show>
    <button class="btn" type="button" disabled={busy() || !selected() && !props.traceId} onClick={() => void run(save)}>{selected() ? 'Save annotations as new revision' : 'Create pinned case snapshot'}</button>
    <Show when={selected()}>{(c) => <>
      <div class="archive-filters">
        <button class="btn ghost" type="button" disabled={busy() || c().revision <= 1} onClick={() => void run(() => choose(c().id, c().revision - 1))}>Previous revision</button>
        <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(() => choose(c().id))}>Latest revision</button>
        <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(async () => { await window.api.evalDelete(c().id); await forget(); setSelected(undefined); setDraft(blank()); setAssertions('[]'); await refresh(); })}>Delete case and ALL its revisions</button>
      </div>
      <p class="muted">Source {shownText(c().provenance.source)} · {shownText(c().provenance.archiveId)} · capture {c().capture.entry.state} · payload {c().capture.payload.state}. Original messages/tools remain protocol content; they are not normalized training examples. Imported provenance is an unauthenticated claim.</p>
      <For each={c().missingContext}>{(reason) => <p class="muted">{shownText(reason)}</p>}</For>
      <details><summary>Inspect pinned protocol snapshot (first 32,768 characters; export preview contains retained content)</summary><pre class="archive-raw">{shownText(JSON.stringify(c().capture, null, 2).slice(0, 32 * 1024))}</pre></details>
      <label><input type="checkbox" checked={exportBodies()} onChange={(e) => setExportBodies(e.currentTarget.checked)} /> Include retained protocol bodies in next export preview</label>
      <p class="muted">Exports are unencrypted. Common credential patterns and current app secrets are redacted; arbitrary private prose requires your review. Redaction can change protocol input and assertions: nested hashes are recomputed and the file records its transformation policy. Replaying changed content is not byte-faithful original replay. Bodies default to omitted. Export preview shows exact saved text without screen email masking. Review annotations and bodies for secrets before saving.</p>
      <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(async () => { setPreview(await window.api.evalExportPrepare(c().id, c().revision, exportBodies())); })}>Prepare export for review</button>
      <button class="btn ghost" type="button" disabled={busy() || result()?.state === 'running'} onClick={() => void run(prepareReplay)}>Preview supported model-call replay</button>
    </>}</Show>
    <Show when={preview()}>{(p) => <div><label>Frozen export ({p().bytes} bytes)<textarea rows="10" readOnly value={p().jsonl} spellcheck={false} /></label><button class="btn" type="button" disabled={busy()} onClick={() => void run(async () => { const path = await window.api.evalExportSave(p().token); setPreview(undefined); if (path) setMessage(`Saved ${path}`); })}>Choose file and save reviewed export</button></div>}</Show>
    <Show when={replay()}>{(r) => <div aria-live="polite">
      <h3>Model-call replay preview</h3><p>{r().environment}</p>
      <p>{r().inputFidelity}</p>
      <p>Model: {shownText(r().model ?? 'unsupported')} · route: {r().route ?? 'unsupported'} · destination: {r().destination || 'unavailable'} · {r().maxOutputTokens} output tokens · {r().timeoutMs / 1000}s deadline. Full agent-task replay: unsupported (no reproducible workspace/tool harness).</p>
      <p>Frozen criteria: {shownText(JSON.stringify(r().assertions))}. Expected outcome: {shownText(r().expectedOutcome || 'unspecified')}. Unsaved annotation edits are excluded.</p>
      <For each={r().reasons}>{(reason) => <p class="notice">{shownText(reason)}</p>}</For>
      <details><summary>Exact request context (stream disabled; token cap applied)</summary><pre class="archive-raw">{shownText(r().request ?? '')}</pre></details>
      <button class="btn" type="button" disabled={busy() || !r().supported || !!result()} onClick={() => void run(async () => { setResult(await window.api.evalReplayStart(r().id)); })}>Run this model call now (uses provider quota)</button>
      <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(async () => { await window.api.evalReplayCancel(r().id); setResult(await window.api.evalReplayStatus(r().id)); })}>Cancel replay</button>
    </div>}</Show>
    <Show when={result()}>{(r) => <div aria-live="polite"><p>Replay {r().state} · HTTP {r().httpStatus ?? 'unknown'} · criteria {r().comparison} · task outcome unknown. {shownText(r().error ?? '')}</p><pre class="archive-raw">{shownText(r().output)}</pre><For each={r().checks}>{(check) => <p>{check.passed ? 'Pass' : 'Fail'}: {check.assertion.kind} {shownText(check.assertion.value)}</p>}</For></div>}</Show>
    <Show when={error()}>{(e) => <p class="notice">{shownText(e())}</p>}</Show>
    <Show when={message()}>{(m) => <p>{shownText(m())}</p>}</Show>
  </section>;
}
