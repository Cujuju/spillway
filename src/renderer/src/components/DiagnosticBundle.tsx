import { createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { DIAGNOSTIC_LIMITS, DIAGNOSTIC_WARNING, type DiagnosticPreview } from '@shared/diagnosticBundle';
import { shownText } from '../store';
import { InfoTip } from './ChartTip';
import { Dialog } from './ui';
import '../styles/diagnosticBundle.css';

const PAGE = 32 * 1024;
const SCOPE_NOTE = `Selected requests only, at most ${DIAGNOSTIC_LIMITS.records}. Nothing is uploaded. The preview is the exact file content and ignores the email display setting; account and conversation IDs become bundle-local aliases.`;
export function DiagnosticBundle(props: { traceIds: string[]; onClose: () => void }) {
  const candidates = untrack(() => [...props.traceIds]);
  const [selected, setSelected] = createSignal(candidates);
  const [bodies, setBodies] = createSignal(false), [settings, setSettings] = createSignal(true), [logs, setLogs] = createSignal(true), [messages, setMessages] = createSignal(false);
  const [preview, setPreview] = createSignal<DiagnosticPreview>();
  const [busy, setBusy] = createSignal(false), [reviewed, setReviewed] = createSignal(false);
  const [error, setError] = createSignal<string>(), [status, setStatus] = createSignal<string>();
  const [page, setPage] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  let operation: string | undefined, generation = 0;
  let cancelRequested = false;
  const discard = (id: string | undefined) => { if (id) void window.api.diagnosticDiscard(id).catch((e) => setError(String(e))); };
  const invalidate = () => { generation++; discard(operation); operation = undefined; discard(preview()?.token); setPreview(undefined); setReviewed(false); setPage(0); setBusy(false); };
  onCleanup(() => { generation++; discard(operation); discard(preview()?.token); });
  const prepare = async () => {
    invalidate(); const gen = generation; operation = crypto.randomUUID();
    setBusy(true); setError(undefined); setStatus(undefined);
    try {
      const next = await window.api.diagnosticPrepare({ operationId: operation, traceIds: selected(), excludedRecords: candidates.length - selected().length, includeBodies: bodies(), includeSettings: settings(), includeLogs: logs(), includeMessages: messages() });
      if (gen !== generation) { discard(next.token); return; }
      setPreview(next); operation = undefined;
    } catch (e) { if (gen === generation) setError(String(e)); }
    finally { if (gen === generation) setBusy(false); }
  };
  const save = async () => {
    const p = preview(); if (!p) return;
    const gen = generation;
    setBusy(true); setSaving(true); cancelRequested = false; setError(undefined); setStatus(undefined);
    try {
      const result = await window.api.diagnosticSave(p.token);
      if (gen !== generation) return;
      setStatus(result.state === 'saved' ? `Saved ${shownText(result.path ?? p.filename)}` : 'Save canceled. Nothing was exported.');
      if (result.state === 'saved' || cancelRequested) { setPreview(undefined); setReviewed(false); }
    } catch (e) { if (gen === generation) setError(String(e)); }
    finally { if (gen === generation) { setBusy(false); setSaving(false); } }
  };
  const cancel = () => {
    if (saving()) { cancelRequested = true; discard(preview()?.token); setStatus('Cancellation requested. Waiting for the final save result; publication may already have finished.'); }
    else invalidate();
  };
  const close = () => { if (saving()) cancel(); else props.onClose(); };
  return <Dialog title="Local diagnostic bundle" onClose={close} actions={<>
    <button class="btn" type="button" onClick={close}>{saving() ? 'Cancel save' : 'Close'}</button>
    <button class="btn primary" type="button" disabled={busy() || !selected().length} onClick={() => void prepare()}>Preview</button>
    <button class="btn primary" type="button" disabled={busy() || !preview() || !reviewed()} onClick={() => void save()}>Save…</button>
  </>}>
    <div class="diagnostic-bundle">
      <p class="diagnostic-warning">Redaction can miss secrets in prompts. Review the JSON before sharing. <InfoTip title="What is collected" note={`${DIAGNOSTIC_WARNING} ${SCOPE_NOTE}`} /></p>
      <div class="diagnostic-selection"><For each={candidates}>{(id) => <label><input type="checkbox" disabled={busy()} checked={selected().includes(id)} onChange={(e) => { invalidate(); setSelected((old) => e.currentTarget.checked ? [...old, id] : old.filter((x) => x !== id)); }} />{shownText(id)}</label>}</For></div>
      <label><input type="checkbox" checked={settings()} disabled={busy()} onChange={(e) => { invalidate(); setSettings(e.currentTarget.checked); }} /> Allowlisted settings</label>
      <label><input type="checkbox" checked={logs()} disabled={busy()} onChange={(e) => { invalidate(); setLogs(e.currentTarget.checked); }} /> Supervisor summary (last 100 app events)</label>
      <label><input type="checkbox" checked={bodies()} disabled={busy()} onChange={(e) => { invalidate(); setBodies(e.currentTarget.checked); }} /> Retained bodies (review required)</label>
      <label><input type="checkbox" checked={messages()} disabled={busy()} onChange={(e) => { invalidate(); setMessages(e.currentTarget.checked); }} /> Redacted error{logs() ? ' and app' : ''} messages (review required)</label>
      <Show when={busy()}><p role="status" class="muted">Working… <button type="button" class="btn ghost" onClick={cancel}>Cancel</button></p></Show>
      <Show when={error()}>{(e) => <p role="alert" class="notice">{shownText(e())}</p>}</Show>
      <Show when={status()}>{(s) => <p role="status">{s()}</p>}</Show>
      <Show when={preview()}>{(p) => <>
        <div class="stat-strip inset">
          <div class="stat-cell"><div class="stat-label">Records</div><div class="stat-value">{p().counts.included} / {p().counts.selected}</div><div class="stat-sub">{p().counts.unavailable} unavailable · {p().counts.partial} partial</div></div>
          <div class="stat-cell"><div class="stat-label">Bodies</div><div class="stat-value">{p().counts.bodiesIncluded}</div><div class="stat-sub">{p().counts.bodiesUnavailable} missing · {p().counts.bodiesOmitted} omitted</div></div>
          <div class="stat-cell"><div class="stat-label">Redacted</div><div class="stat-value">{p().counts.redacted}</div><div class="stat-sub">{p().counts.omitted} omitted</div></div>
          <div class="stat-cell"><div class="stat-label">Size</div><div class="stat-value">{(p().bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB</div><div class="stat-sub">expires {new Date(p().expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div></div>
        </div>
        <div class="diagnostic-pages"><button class="btn ghost" type="button" disabled={!page()} onClick={() => setPage((n) => n - 1)}>Previous</button><span class="muted">{(page() * PAGE + 1).toLocaleString()}–{Math.min((page() + 1) * PAGE, p().json.length).toLocaleString()} of {p().json.length.toLocaleString()} chars</span><button class="btn ghost" type="button" disabled={(page() + 1) * PAGE >= p().json.length} onClick={() => setPage((n) => n + 1)}>Next</button></div>
        <pre class="diagnostic-json" tabIndex={0}>{p().json.slice(page() * PAGE, (page() + 1) * PAGE)}</pre>
        <label><input type="checkbox" checked={reviewed()} onChange={(e) => setReviewed(e.currentTarget.checked)} /> I reviewed this content.</label>
      </>}</Show>
    </div>
  </Dialog>;
}
