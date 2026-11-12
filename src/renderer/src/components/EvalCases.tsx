import { Download, Plus, RefreshCw, X } from 'lucide-solid';
import { createSignal, For, Index, onCleanup, onMount, Show } from 'solid-js';
import { EVAL_ASSERTION_LIMITS, type EvalAnnotation, type EvalAssertion, type EvalCase, type EvalCaseSummary, type EvalExportPreview, type EvalReplayPreview, type EvalReplayResult } from '@shared/evalCase';
import { shownText } from '../store';
import { InfoTip } from './ChartTip';
import { Seg, SettingRow, Toggle } from './ui';
import '../styles/archive.css';
import { appLocale } from '@shared/timeFormat';

const ICON_PX = 14;
/** A running replay reports its result this often. */
const REPLAY_POLL_MS = 400;
/** Characters of a pinned snapshot rendered inline; the export preview has the rest. */
const SNAPSHOT_PREVIEW_CHARS = 32 * 1024;
const MS_PER_SECOND = 1000;
const CASES_NOTE = 'Pinned, encrypted snapshots that outlive body expiry and Delete recorded bodies. Each save is a new immutable revision. Limits: 200 cases, 8 revisions and 8 MiB per case, 64 MiB total. Deleting all Activity deletes cases too.';
const REPLAY_NOTE = 'Replay supports self-contained text-only POST /v1/chat/completions and /v1/messages. Responses/Codex, WebSocket, tools and attachments stay inspect-only. Full agent-task replay needs a reproducible workspace this app does not provide.';
const ASSERT_NOTE = 'Exact, case-sensitive checks on the replayed model output. All must pass; nothing executes.';
const LABEL_NOTE = 'Labels for people reading the case. Replay never checks out code.';
const ASSERTION_KINDS: readonly { value: EvalAssertion['kind']; label: string }[] = [
  { value: 'contains', label: 'Contains' }, { value: 'not-contains', label: 'Excludes' }, { value: 'equals', label: 'Equals' },
];
const SOURCE_LABEL: Record<EvalCase['provenance']['source'], string> = { 'local-archive': 'Recorded exchange', 'portable-import': 'Imported file' };
const EXPORT_NOTE = 'Exports are unencrypted. Known credential patterns and app secrets are redacted; review prose yourself. Redaction can change replay input, and the file records its policy.';

const blank = (): EvalAnnotation => ({ title: '', notes: '', expectedOutcome: '', assertions: [], context: { repository: '', revision: '', workspace: 'unknown', notes: '' } });
/** Pinned eval cases. `traceId` is the exchange a new case starts from (New eval case in Traces); `onSourceUsed` drops it once created or canceled. */
export function EvalCases(props: { traceId?: string; onSourceUsed: () => void }) {
  const [list, setList] = createSignal<EvalCaseSummary[]>([]);
  const [selected, setSelected] = createSignal<EvalCase>();
  const [draft, setDraft] = createSignal(blank());
  const [bodies, setBodies] = createSignal(false);
  const [exportBodies, setExportBodies] = createSignal(false);
  const [preview, setPreview] = createSignal<EvalExportPreview>();
  const [replay, setReplay] = createSignal<EvalReplayPreview>();
  const [result, setResult] = createSignal<EvalReplayResult>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [message, setMessage] = createSignal<string>();
  /** The editor opens for a chosen case or after New. */
  const [editing, setEditing] = createSignal(false);
  let disposed = false, polling = false;
  const refresh = async () => { const rows = await window.api.evalList(); if (!disposed) setList(rows); };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(undefined); setMessage(undefined);
    try { await fn(); } catch (e) { if (!disposed) setError(String(e)); } finally { if (!disposed) setBusy(false); }
  };
  onMount(() => void run(async () => { await refresh(); if (props.traceId) setEditing(true); }));
  const forget = async () => {
    const r = replay(); if (r) await window.api.evalReplayCancel(r.id);
    await window.api.evalExportDiscard(); setPreview(undefined); setReplay(undefined); setResult(undefined);
  };
  const choose = async (id: string, revision?: number) => {
    await forget(); const c = await window.api.evalGet(id, revision); if (disposed) return;
    setSelected(c); setDraft(c.annotation); setEditing(true);
  };
  const reset = async () => { await forget(); setSelected(undefined); setDraft(blank()); };
  /** Rows left blank are dropped rather than rejected. */
  const annotation = (): EvalAnnotation => ({ ...draft(), assertions: draft().assertions.filter((a) => a.value) });
  const assertions = (next: (list: EvalAssertion[]) => EvalAssertion[]) => setDraft((d) => ({ ...d, assertions: next(d.assertions) }));
  const assertion = (i: number, patch: Partial<EvalAssertion>) => assertions((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const save = async () => {
    const c = selected(); await forget();
    const saved = c ? await window.api.evalRevise(c.id, c.revision, annotation()) : await window.api.evalCreate(props.traceId!, annotation(), bodies());
    if (!c) props.onSourceUsed();
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
  }, REPLAY_POLL_MS);
  onCleanup(() => { disposed = true; clearInterval(timer); void forget().catch((e) => console.error('Eval preview cleanup failed', e)); });
  const field = (key: 'title' | 'notes' | 'expectedOutcome', value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const context = (key: 'repository' | 'revision' | 'notes', value: string) => setDraft((d) => ({ ...d, context: { ...d.context, [key]: value } }));
  return <section class="card eval-cases">
    <div class="panel-head">
      <h2 class="card-title">Eval cases</h2>
      <InfoTip title="Eval cases" note={CASES_NOTE} />
      <div class="panel-head-end">
        <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(async () => { const rows = await window.api.evalImport(); await refresh(); setMessage(`Imported ${rows.length} revisions. Imports never run.`); })}><Download size={ICON_PX} />Import…</button>
        <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(async () => { await reset(); setEditing(true); })}><Plus size={ICON_PX} />New</button>
        <button class="btn icon-btn ghost" type="button" title="Refresh" aria-label="Refresh" disabled={busy()} onClick={() => void run(refresh)}><RefreshCw size={ICON_PX} /></button>
      </div>
    </div>
    <Show when={list().length}>
      <div class="archive-table eval-list">
        <table class="table dense">
          <thead><tr><th>Case</th><th class="num">Revision</th></tr></thead>
          <tbody><For each={list()}>{(c) => (
            <tr classList={{ selected: selected()?.id === c.id }}>
              <td class="fill"><button class="sort-btn" type="button" disabled={busy()} onClick={() => void run(() => choose(c.id))}>{shownText(c.title) || 'Untitled'}</button></td>
              <td class="num tabular">{c.revision}</td>
            </tr>
          )}</For></tbody>
        </table>
      </div>
    </Show>

    <Show when={!editing()}><p class="empty-note">{list().length ? 'Choose a case to edit or replay it.' : 'No cases yet. Open an exchange in Traces and choose New eval case.'}</p></Show>
    <Show when={editing()}>
    <div class="panel-head eval-editor-head">
      <h3 class="section-label">{selected() ? `Revision ${selected()!.revision}` : 'New case'}</h3>
      <Show when={!selected()}><span class="panel-count">{props.traceId ? 'from the opened exchange' : 'open an exchange in Traces first'}</span></Show>
    </div>
    <div class="form-grid">
      <label class="form-field"><span>Title</span><input class="input" maxLength={160} value={draft().title} onInput={(e) => field('title', e.currentTarget.value)} /></label>
      <label class="form-field"><span>Repository <InfoTip title="Repository and revision" note={LABEL_NOTE} /></span><input class="input" placeholder="owner/repo" value={draft().context.repository} onInput={(e) => context('repository', e.currentTarget.value)} /></label>
      <label class="form-field"><span>Revision</span><input class="input" placeholder="Commit or branch" value={draft().context.revision} onInput={(e) => context('revision', e.currentTarget.value)} /></label>
      <label class="form-field wide"><span>Notes</span><textarea class="input" rows="2" value={draft().notes} onInput={(e) => field('notes', e.currentTarget.value)} /></label>
      <label class="form-field wide"><span>Expected outcome</span><textarea class="input" rows="2" placeholder="For human review" value={draft().expectedOutcome} onInput={(e) => field('expectedOutcome', e.currentTarget.value)} /></label>
      <label class="form-field wide"><span>Missing context</span><textarea class="input" rows="2" placeholder="Workspace, tools, files" value={draft().context.notes} onInput={(e) => context('notes', e.currentTarget.value)} /></label>
      <div class="form-field wide"><span>Assertions <InfoTip title="Assertions" note={ASSERT_NOTE} /></span>
        <Index each={draft().assertions}>{(a, i) => (
          <div class="assertion-row">
            <Seg label="Check" value={a().kind} options={ASSERTION_KINDS} onChange={(kind) => assertion(i, { kind })} />
            {/* A textarea, since an input drops line breaks the literal match needs. */}
            <textarea class="input" rows="1" spellcheck={false} aria-label="Expected text" placeholder="Expected text" maxLength={EVAL_ASSERTION_LIMITS.valueChars} value={a().value} onInput={(e) => assertion(i, { value: e.currentTarget.value })} />
            <button class="btn icon-btn ghost" type="button" aria-label="Remove assertion" onClick={() => assertions((list) => list.filter((_, j) => j !== i))}><X size={ICON_PX} /></button>
          </div>
        )}</Index>
        <button class="btn ghost assertion-add" type="button" disabled={draft().assertions.length >= EVAL_ASSERTION_LIMITS.count} onClick={() => assertions((list) => [...list, { kind: 'contains', value: '' }])}><Plus size={ICON_PX} />Add assertion</button>
      </div>
    </div>
    <Show when={!selected()}>
      <div class="inspect-rows"><SettingRow label="Pin bodies" help="Store recorded protocol bodies with the case. May contain private text.">
        <Toggle value={bodies()} label="Pin bodies" onChange={setBodies} />
      </SettingRow></div>
    </Show>
    <div class="inspect-actions">
      <Show when={selected()}>{(c) => <>
        <button class="btn danger" type="button" disabled={busy()} onClick={() => void run(async () => { await window.api.evalDelete(c().id); await reset(); setEditing(false); await refresh(); })}>Delete case</button>
        <span class="spacer" />
        <button class="btn ghost" type="button" disabled={busy() || c().revision <= 1} onClick={() => void run(() => choose(c().id, c().revision - 1))}>Previous</button>
        <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(() => choose(c().id))}>Latest</button>
      </>}</Show>
      <Show when={!selected()}><button class="btn ghost" type="button" disabled={busy()} onClick={() => { setEditing(false); props.onSourceUsed(); }}>Cancel</button></Show>
      <button class="btn primary" type="button" disabled={busy() || !selected() && !props.traceId} onClick={() => void run(save)}>{selected() ? 'Save revision' : 'Create case'}</button>
    </div>
    </Show>

    <Show when={selected()}>{(c) => <div class="eval-section">
      <dl class="kv-grid">
        <div class="kv"><dt>Source</dt><dd>{SOURCE_LABEL[c().provenance.source]}</dd></div>
        <div class="kv"><dt>Capture</dt><dd>{c().capture.entry.state}</dd></div>
        <div class="kv"><dt>Payload</dt><dd>{c().capture.payload.state}</dd></div>
        <div class="kv kv-wide"><dt>Exchange ID</dt><dd class="selectable">{shownText(c().provenance.archiveId)}</dd></div>
      </dl>
      <For each={c().missingContext}>{(reason) => <p class="notice info inspect-notice">{shownText(reason)}</p>}</For>
      <details class="inspect-details"><summary>Pinned snapshot</summary><pre class="archive-raw">{shownText(JSON.stringify(c().capture, null, 2).slice(0, SNAPSHOT_PREVIEW_CHARS))}</pre></details>
      <div class="inspect-rows"><SettingRow label="Export with bodies" help="Include retained protocol bodies in the next export.">
        <Toggle value={exportBodies()} label="Export with bodies" onChange={setExportBodies} />
      </SettingRow></div>
      <div class="inspect-actions">
        <InfoTip title="Export" note={EXPORT_NOTE} />
        <span class="spacer" />
        <button class="btn ghost" type="button" disabled={busy() || result()?.state === 'running'} onClick={() => void run(prepareReplay)}>Preview replay</button>
        <button class="btn" type="button" disabled={busy()} onClick={() => void run(async () => { setPreview(await window.api.evalExportPrepare(c().id, c().revision, exportBodies())); })}>Prepare export</button>
      </div>
    </div>}</Show>

    <Show when={preview()}>{(p) => <div class="eval-section">
      <div class="panel-head"><h3 class="section-label">Export preview</h3><span class="panel-count">{p().bytes.toLocaleString(appLocale())} bytes</span>
        <div class="panel-head-end"><button class="btn primary" type="button" disabled={busy()} onClick={() => void run(async () => { const path = await window.api.evalExportSave(p().token); setPreview(undefined); if (path) setMessage(`Saved ${path}`); })}>Save file…</button></div>
      </div>
      <textarea class="input archive-raw" rows="10" readOnly value={p().jsonl} spellcheck={false} />
    </div>}</Show>
    <Show when={replay()}>{(r) => <div class="eval-section" aria-live="polite">
      <div class="panel-head"><h3 class="section-label">Replay</h3><InfoTip title="Replay" rows={[
          { label: 'Assertions', value: r().assertions.length.toLocaleString(appLocale()) },
          { label: 'Expected', value: shownText(r().expectedOutcome || '—') },
        ]} note={`${r().environment} ${r().inputFidelity} ${REPLAY_NOTE}`} />
        <div class="panel-head-end">
          <button class="btn ghost" type="button" disabled={busy()} onClick={() => void run(async () => { await window.api.evalReplayCancel(r().id); setResult(await window.api.evalReplayStatus(r().id)); })}>Cancel</button>
          <button class="btn primary" type="button" disabled={busy() || !r().supported || !!result()} onClick={() => void run(async () => { setResult(await window.api.evalReplayStart(r().id)); })}>Run (uses quota)</button>
        </div>
      </div>
      <dl class="kv-grid">
        <div class="kv"><dt>Model</dt><dd>{shownText(r().model ?? 'Unsupported')}</dd></div>
        <div class="kv"><dt>Route</dt><dd>{r().route ?? 'Unsupported'}</dd></div>
        <div class="kv"><dt>Output cap</dt><dd>{r().maxOutputTokens.toLocaleString(appLocale())} tokens</dd></div>
        <div class="kv"><dt>Deadline</dt><dd>{r().timeoutMs / MS_PER_SECOND} s</dd></div>
        <div class="kv kv-wide"><dt>Destination</dt><dd class="selectable">{r().destination || '—'}</dd></div>
      </dl>
      <For each={r().reasons}>{(reason) => <p class="notice inspect-notice">{shownText(reason)}</p>}</For>
      <details class="inspect-details"><summary>Request</summary><pre class="archive-raw">{shownText(r().request ?? '')}</pre></details>
    </div>}</Show>
    <Show when={result()}>{(r) => <div class="eval-section" aria-live="polite">
      <div class="panel-head"><h3 class="section-label">Result</h3>
        <span class={`badge compact ${r().comparison === 'pass' ? 'green' : r().comparison === 'fail' ? 'red' : ''}`}>{r().comparison}</span>
        <span class="panel-count">{r().state} · HTTP {r().httpStatus ?? '—'}</span>
      </div>
      <Show when={r().error}><p class="notice error inspect-notice">{shownText(r().error!)}</p></Show>
      <pre class="archive-raw">{shownText(r().output)}</pre>
      <div class="tag-row"><For each={r().checks}>{(check) => <span class={`badge ${check.passed ? 'green' : 'red'}`}>{check.assertion.kind}: {shownText(check.assertion.value)}</span>}</For></div>
    </div>}</Show>
    <Show when={error()}>{(e) => <p class="notice error inspect-notice">{shownText(e())}</p>}</Show>
    <Show when={message()}>{(m) => <p class="notice info inspect-notice">{shownText(m())}</p>}</Show>
  </section>;
}
