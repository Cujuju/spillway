import { createSignal, onCleanup, Show } from 'solid-js';
import type { ArchiveQuery } from '@shared/archive';
import type { ArchiveExportJob } from '@shared/archiveExport';
import { shownText } from '../store';
import { HoverTip, InfoTip } from './ChartTip';
import { SettingRow, Toggle } from './ui';

const MiB = 1024 * 1024;
/** Writing a file reports progress this often. */
const POLL_MS = 500;
const EXPORT_NOTE = 'A versioned JSON Lines file for inspection, eval or replay tools. The preview freezes every matching record, not only the loaded page.';
const PRIVACY_NOTE = 'Files are unencrypted and keep original text, including emails and secrets in prompts; screen masking does not apply. Auth files, credentials, headers and query strings are never exported.';
const FAILED_STATES: readonly ArchiveExportJob['state'][] = ['canceled', 'expired', 'failed'];

export function ArchiveExport(props: { query: ArchiveQuery; traceId?: string }) {
  const [include, setInclude] = createSignal(false);
  const [job, setJob] = createSignal<ArchiveExportJob>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let disposed = false;
  let polling = false;
  const working = () => job()?.state === 'writing' || job()?.state === 'finalizing';
  const poll = setInterval(() => {
    const current = job();
    if (!current || polling || !['preview', 'writing', 'finalizing'].includes(current.state)) return;
    polling = true;
    void window.api.archiveExportStatus(current.id).then((value) => { if (!disposed && job()?.id === value.id) setJob(value); })
      .catch((e) => { if (!disposed) setError(String(e)); }).finally(() => { polling = false; });
  }, POLL_MS);
  onCleanup(() => {
    disposed = true; clearInterval(poll);
    const current = job();
    if (current && ['preview', 'writing'].includes(current.state)) void window.api.archiveExportCancel(current.id).catch((e) => console.error('Export cleanup failed', e));
  });
  const prepare = async (single = false) => {
    setBusy(true); setError(undefined);
    try {
      const { before: _before, ...query } = props.query;
      const value = await window.api.archiveExportPrepare({ ...(single && props.traceId ? { ids: [`trace:${props.traceId}`] } : { query }), includeRecordedBodies: include() });
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
  return <section class="card">
    <div class="panel-head">
      <h2 class="card-title">Export</h2>
      <InfoTip title="Portable export" note={EXPORT_NOTE} />
      <div class="panel-head-end">
        <button class="btn ghost" type="button" disabled={busy() || working() || !props.traceId} onClick={() => void prepare(true)}>Preview selected</button>
        <button class="btn" type="button" disabled={busy() || working()} onClick={() => void prepare()}>Preview filtered</button>
      </div>
    </div>
    <div class="inspect-rows">
      <SettingRow label="Include bodies" help="Recorded request, response and WebSocket payloads, where kept.">
        <HoverTip title="Privacy" rows={[]} note={PRIVACY_NOTE} layout="contents">
          <Toggle value={include()} disabled={busy() || working()} label="Include bodies" onChange={setInclude} />
        </HoverTip>
      </SettingRow>
    </div>
    <Show when={job()}>{(j) => <div class="export-job" aria-live="polite">
      <div class="stat-strip inset">
        <div class="stat-cell"><div class="stat-label">Records</div><div class="stat-value">{j().manifest.records.toLocaleString()}</div>
          <div class="stat-sub">{j().manifest.unresolvedIds.length ? `${j().manifest.unresolvedIds.length} unavailable` : 'all resolved'}</div></div>
        <div class="stat-cell"><div class="stat-label">Snapshot</div><div class="stat-value">{(j().manifest.snapshotBytes / MiB).toFixed(1)} MiB</div>
          <div class="stat-sub">{j().manifest.rawPayloads === 'omitted' ? 'no bodies' : 'with bodies'}</div></div>
        <HoverTip layout="block" title="Capture states" rows={Object.entries(j().manifest.captureStates).filter(([, n]) => n > 0).map(([state, n]) => ({ label: state, value: n.toLocaleString() }))}
          note="Missing, expired and partial records keep their state; malformed payloads are marked.">
          <div class="stat-cell"><div class="stat-label">Expires</div><div class="stat-value">{new Date(j().manifest.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
            <div class="stat-sub">frozen {new Date(j().manifest.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div></div>
        </HoverTip>
        <Show when={working() || j().state === 'complete'}>
          <div class="stat-cell"><div class="stat-label">{j().state === 'complete' ? 'Saved' : j().state === 'finalizing' ? 'Finishing' : 'Writing'}</div>
            <div class="stat-value">{j().writtenRecords.toLocaleString()} / {j().manifest.records.toLocaleString()}</div>
            <div class="stat-sub">{(j().writtenBytes / MiB).toFixed(1)} MiB</div></div>
        </Show>
      </div>
      <div class="inspect-actions">
        <Show when={j().state === 'complete'}><span class="muted selectable">{shownText(j().path ?? '')}</span></Show>
        <Show when={j().state === 'preview' || j().state === 'writing'}><button class="btn ghost" type="button" disabled={busy()} onClick={() => void cancel()}>Cancel</button></Show>
        <Show when={j().state === 'preview'}><button class="btn primary" type="button" disabled={busy() || !j().manifest.records} onClick={() => void save()}>Save file…</button></Show>
      </div>
      <Show when={j().warning}><p class="notice inspect-notice">Cleanup: {shownText(j().warning!)}</p></Show>
      <Show when={FAILED_STATES.includes(j().state)}><p class="notice error inspect-notice">Export {j().state}. {j().error ? shownText(j().error!) : 'No file was saved.'}</p></Show>
    </div>}</Show>
    <Show when={error()}>{(e) => <p class="notice error inspect-notice">{shownText(e())}</p>}</Show>
  </section>;
}
