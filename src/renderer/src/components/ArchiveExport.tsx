import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { ArchiveQuery } from '@shared/archive';
import type { ArchiveExportJob } from '@shared/archiveExport';
import { shownText } from '../store';

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
  }, 500);
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
  return <section class="card request-inspector">
    <h2>Portable archive export</h2>
    <p>Save a versioned JSON Lines file for inspection, eval or replay tools. The preview freezes all matching records, including pages not currently displayed.</p>
    <label><input type="checkbox" checked={include()} disabled={busy() || working()} onChange={(e) => setInclude(e.currentTarget.checked)} /> Include previously recorded raw bodies and WebSocket messages in the next preview</label>
    <p class="muted">Files are unencrypted. Metadata and optional payloads retain original text, including emails and secrets supplied in prompts. Screen masking does not redact exports. Auth files, credentials, headers and query strings are outside this export. HTTP success does not establish task success.</p>
    <div class="archive-filters">
      <button class="btn ghost" type="button" disabled={busy() || working()} onClick={() => void prepare()}>Preview filtered export</button>
      <button class="btn ghost" type="button" disabled={busy() || working() || !props.traceId} onClick={() => void prepare(true)}>Preview selected capture</button>
    </div>
    <Show when={job()}>{(j) => <div aria-live="polite">
      <p>{j().manifest.records.toLocaleString()} records · {(j().manifest.snapshotBytes / 1024 / 1024).toFixed(1)} MiB snapshot · {j().manifest.rawPayloads === 'omitted' ? 'Raw payloads omitted' : 'Recorded raw payloads included when available'}</p>
      <p class="muted">Frozen {new Date(j().manifest.createdAt).toLocaleString()} · expires {new Date(j().manifest.expiresAt).toLocaleTimeString()} · {shownText(JSON.stringify(j().manifest.selection))}</p>
      <p class="muted"><For each={Object.entries(j().manifest.captureStates).filter(([, n]) => n > 0)}>{([state, count]) => <span>{state}: {count} · </span>}</For>Missing, expired and partial records retain their state. Malformed stored payloads are marked in the saved file.</p>
      <Show when={j().manifest.unresolvedIds.length}><p class="notice">{j().manifest.unresolvedIds.length} selected identities were unavailable at snapshot time.</p></Show>
      <Show when={j().state === 'preview'}><button class="btn" type="button" disabled={busy() || !j().manifest.records} onClick={() => void save()}>Choose file and export this snapshot</button></Show>
      <Show when={j().state === 'preview' || j().state === 'writing'}><button class="btn ghost" type="button" disabled={busy()} onClick={() => void cancel()}>Cancel export</button></Show>
      <Show when={working()}><p>{j().state === 'finalizing' ? 'Finishing file…' : 'Writing…'} {j().writtenRecords} / {j().manifest.records} records · {(j().writtenBytes / 1024 / 1024).toFixed(1)} MiB</p></Show>
      <Show when={j().state === 'complete'}><p>Saved {shownText(j().path ?? '')} · {j().writtenRecords} records</p></Show>
      <Show when={j().warning}><p class="notice">Cleanup warning: {shownText(j().warning!)}</p></Show>
      <Show when={['canceled', 'expired', 'failed'].includes(j().state)}><p class="notice">Export {j().state}. {j().error ? shownText(j().error!) : 'No completed file was saved.'}</p></Show>
    </div>}</Show>
    <Show when={error()}>{(e) => <p class="notice">{shownText(e())}</p>}</Show>
  </section>;
}
