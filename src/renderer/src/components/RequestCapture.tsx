import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { ArchivePolicy, ArchiveStatus } from '@shared/archive';
import { shownText } from '../store';
import { byteSize } from '../lib/format';
import { HoverTip } from './ChartTip';
import { Dialog, Notice, NumberField, SettingRow, SettingsGroup, Toggle } from './ui';

const MiB = 1024 * 1024;
/** Bounds from normalizeArchivePolicy (src/shared/archive.ts). */
const RETENTION_DAYS = { min: 1, max: 90 };
const BUDGET_MIB = { min: 1, max: 1024 };
/** Store health (drops, bytes) changes as traffic arrives. */
const STATUS_POLL_MS = 3_000;
const LIMITS_NOTE = 'HTTP: 256 KiB per request and response (gzip, zstd decoded). Codex WebSocket: 128 messages, 64 KiB each, 256 KiB per direction. Truncation is marked. Up to 20,000 requests keep their capture record. Bodies are encrypted with the Activity database key.';
const DELETE_NOTE = 'Deletes every recorded request and response and turns Record bodies off. Activity history and eval cases stay.';

/** Drops and rejections, shown only when any happened. */
function Losses(props: { status: ArchiveStatus }) {
  const s = () => props.status;
  return <>
    <Show when={s().dropped > 0}>
      <HoverTip title="Dropped" rows={[{ label: 'Dropped', value: s().dropped.toLocaleString() }, { label: 'Sequence gaps', value: s().gaps.toLocaleString() }, { label: 'Proxy restarts', value: s().restarts.toLocaleString() }]}
        note="Captures the proxy could not hand over, from overflow, disconnects or crashes. Gaps overlap drops; don't add them.">
        <span class="badge compact red">{s().dropped.toLocaleString()} dropped</span>
      </HoverTip>
    </Show>
    <Show when={s().rejected > 0}>
      <HoverTip title="Rejected" rows={[{ label: 'Records', value: s().rejected.toLocaleString() }]} note="Captures the app refused as malformed or over its limits.">
        <span class="badge compact red">{s().rejected.toLocaleString()} rejected</span>
      </HoverTip>
    </Show>
  </>;
}

/** Settings → Data → Request capture: the body-recording policy, storage health and deletion. */
export function RequestCaptureSettings() {
  const [status, setStatus] = createSignal<ArchiveStatus & { syncError?: string | null }>();
  const [busy, setBusy] = createSignal(false), [confirming, setConfirming] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let mounted = true;
  const refresh = () => window.api.archiveStatus().then((s) => { if (mounted) setStatus(s); }).catch((e) => { if (mounted) setError(String(e)); });
  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS);
    onCleanup(() => { mounted = false; clearInterval(timer); });
  });
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await work(); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const save = (patch: Partial<ArchivePolicy>) => {
    const s = status(); if (!s) return;
    void action(async () => setStatus(await window.api.archivePolicy({ ...s.policy, ...patch })));
  };
  return (
    <SettingsGroup>
      <Show when={status()} fallback={<p class="empty-note">Loading…</p>}>{(s) => <>
        <SettingRow label="Record bodies" help="Keep the text of requests and responses from now on. Time, model, account and status are always kept.">
          <Toggle value={s().policy.captureBodies} disabled={busy()} label="Record bodies" onChange={(captureBodies) => save({ captureBodies })} />
        </SettingRow>
        <SettingRow label="Keep bodies" help="Older text is removed; the request stays in Activity.">
          <NumberField value={s().policy.retentionDays} {...RETENTION_DAYS} unit="days" onCommit={(retentionDays) => save({ retentionDays })} />
        </SettingRow>
        <SettingRow label="Body budget" help="When full, the oldest text is removed first.">
          <NumberField value={s().policy.maxBytes / MiB} {...BUDGET_MIB} unit="MiB" onCommit={(n) => save({ maxBytes: n * MiB })} />
        </SettingRow>
        <SettingRow label="Storage">
          <Losses status={s()} />
          <HoverTip title="Storage" rows={[
            { label: 'Records', value: s().entries.toLocaleString() },
            { label: 'Bodies stored', value: byteSize(s().bytes) },
            { label: 'Budget', value: byteSize(s().policy.maxBytes) },
            { label: 'Keep bodies', value: `${s().policy.retentionDays} days` },
          ]} note={LIMITS_NOTE}>
            <span class="tabular secondary">{s().entries.toLocaleString()} records · {byteSize(s().bytes)} of {byteSize(s().policy.maxBytes)}</span>
          </HoverTip>
        </SettingRow>
        <SettingRow label="Delete recorded bodies" help={DELETE_NOTE}>
          <button class="btn danger" type="button" disabled={busy() || s().entries === 0} onClick={() => setConfirming(true)}>Delete…</button>
        </SettingRow>
        <Show when={s().syncError}>{(e) => <Notice tone="error">Capture sync failed: {shownText(e())}</Notice>}</Show>
        <Show when={s().exportWarning}>{(w) => <Notice>Export cleanup: {shownText(w())}</Notice>}</Show>
      </>}</Show>
      <Show when={error()}>{(e) => <Notice tone="error">{shownText(e())}</Notice>}</Show>
      <Show when={confirming()}>
        <Dialog title="Delete recorded bodies?" onClose={() => setConfirming(false)} actions={<>
          <button class="btn" type="button" onClick={() => setConfirming(false)}>Cancel</button>
          <button class="btn danger" type="button" disabled={busy()} onClick={() => { setConfirming(false); void action(() => window.api.archiveClear()); }}>Delete</button>
        </>}>
          <p class="secondary">{DELETE_NOTE}</p>
        </Dialog>
      </Show>
    </SettingsGroup>
  );
}
