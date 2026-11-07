import { createSignal, onCleanup, Show } from 'solid-js';
import type { ArchiveExportJob, ArchiveExportOptions } from '@shared/archiveExport';
import { shownText } from '../store';
import { byteSize } from '../lib/format';
import { HoverTip, InfoTip } from './ChartTip';
import { Dialog, SettingRow, Toggle } from './ui';
import '../styles/archive.css';

/** Writing a file reports progress this often. */
const POLL_MS = 500;
const EXPORT_NOTE = 'A versioned JSON Lines file for inspection, eval or replay tools. The preview freezes every matching exchange, not only the loaded rows, and expires after 15 minutes.';
const PRIVACY_NOTE = 'Files are unencrypted and keep original text, including emails and secrets in prompts; screen masking does not apply. Auth files, credentials, headers and query strings are never exported.';
const LIVE_STATES: readonly ArchiveExportJob['state'][] = ['preview', 'writing', 'finalizing'];
const FAILED_STATES: readonly ArchiveExportJob['state'][] = ['canceled', 'expired', 'failed'];
const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Portable export of `selection` (a query or exact archive IDs): preview a frozen snapshot, then save it. Closing cancels an unsaved preview. */
export function PortableExportDialog(props: { selection: Pick<ArchiveExportOptions, 'query' | 'ids'>; subject: string; onClose: () => void }) {
  const [include, setInclude] = createSignal(false);
  const [job, setJob] = createSignal<ArchiveExportJob>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let disposed = false;
  let polling = false;
  const working = () => job()?.state === 'writing' || job()?.state === 'finalizing';
  const poll = setInterval(() => {
    const current = job();
    if (!current || polling || !LIVE_STATES.includes(current.state)) return;
    polling = true;
    void window.api.archiveExportStatus(current.id).then((value) => { if (!disposed && job()?.id === value.id) setJob(value); })
      .catch((e) => { if (!disposed) setError(String(e)); }).finally(() => { polling = false; });
  }, POLL_MS);
  onCleanup(() => {
    disposed = true; clearInterval(poll);
    const current = job();
    if (current && ['preview', 'writing'].includes(current.state)) void window.api.archiveExportCancel(current.id).catch((e) => console.error('Export cleanup failed', e));
  });
  const prepare = async () => {
    setBusy(true); setError(undefined);
    try {
      const value = await window.api.archiveExportPrepare({ ...props.selection, includeRecordedBodies: include() });
      if (disposed) await window.api.archiveExportCancel(value.id);
      else setJob(value);
    } catch (e) { if (!disposed) setError(String(e)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    const current = job(); if (!current) return;
    setBusy(true); setError(undefined);
    try { const value = await window.api.archiveExportSave(current.id); if (!disposed) setJob(value); }
    catch (e) { if (!disposed) setError(String(e)); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    const current = job(); if (!current) return;
    try { setJob(await window.api.archiveExportCancel(current.id)); }
    catch (e) { setError(String(e)); }
  };
  const previewing = () => job()?.state === 'preview';
  return <Dialog title="Export exchanges" onClose={props.onClose} actions={<>
    <Show when={previewing() || job()?.state === 'writing'} fallback={<button class="btn" type="button" onClick={() => props.onClose()}>Close</button>}>
      <button class="btn" type="button" disabled={busy()} onClick={() => void cancel()}>Cancel</button>
    </Show>
    <Show when={previewing()} fallback={<button class="btn primary" type="button" disabled={busy() || working()} onClick={() => void prepare()}>Preview</button>}>
      <button class="btn primary" type="button" disabled={busy() || !job()!.manifest.records} onClick={() => void save()}>Save file…</button>
    </Show>
  </>}>
    <p class="dialog-sub"><span class="dialog-sub-text">{shownText(props.subject)}</span><InfoTip title="Portable export" note={EXPORT_NOTE} /></p>
    <div class="inspect-rows">
      <SettingRow label="Include bodies" help="Recorded requests, responses and WebSocket messages, where kept. Applies to the next preview.">
        <HoverTip title="Privacy" rows={[]} note={PRIVACY_NOTE} layout="contents">
          <Toggle value={include()} disabled={busy() || working()} label="Include bodies" onChange={setInclude} />
        </HoverTip>
      </SettingRow>
    </div>
    <Show when={job()}>{(j) => <div class="export-job" aria-live="polite">
      <div class="stat-strip inset">
        <div class="stat-cell"><div class="stat-label">Exchanges</div><div class="stat-value">{j().manifest.records.toLocaleString()}</div>
          <div class="stat-sub">{j().manifest.unresolvedIds.length ? `${j().manifest.unresolvedIds.length} unavailable` : 'all resolved'}</div></div>
        <div class="stat-cell"><div class="stat-label">Snapshot</div><div class="stat-value">{byteSize(j().manifest.snapshotBytes)}</div>
          <div class="stat-sub">{j().manifest.rawPayloads === 'omitted' ? 'no bodies' : 'with bodies'}</div></div>
        <HoverTip layout="block" title="Capture states" rows={Object.entries(j().manifest.captureStates).filter(([, n]) => n > 0).map(([state, n]) => ({ label: state, value: n.toLocaleString() }))}
          note="Missing, expired and partial exchanges keep their state; malformed payloads are marked.">
          <div class="stat-cell"><div class="stat-label">Expires</div><div class="stat-value">{clock(j().manifest.expiresAt)}</div>
            <div class="stat-sub">frozen {clock(j().manifest.createdAt)}</div></div>
        </HoverTip>
        <Show when={working() || j().state === 'complete'}>
          <div class="stat-cell"><div class="stat-label">{j().state === 'complete' ? 'Saved' : j().state === 'finalizing' ? 'Finishing' : 'Writing'}</div>
            <div class="stat-value">{j().writtenRecords.toLocaleString()} / {j().manifest.records.toLocaleString()}</div>
            <div class="stat-sub">{byteSize(j().writtenBytes)}</div></div>
        </Show>
      </div>
      <Show when={j().state === 'complete'}><p class="muted selectable export-path">{shownText(j().path ?? '')}</p></Show>
      <Show when={j().warning}><p class="notice inspect-notice">Cleanup: {shownText(j().warning!)}</p></Show>
      <Show when={FAILED_STATES.includes(j().state)}><p class="notice error inspect-notice">Export {j().state}. {j().error ? shownText(j().error!) : 'No file was saved.'}</p></Show>
    </div>}</Show>
    <Show when={error()}>{(e) => <p class="notice error inspect-notice">{shownText(e())}</p>}</Show>
  </Dialog>;
}
