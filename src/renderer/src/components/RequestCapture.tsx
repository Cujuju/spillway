import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { type ArchivePolicy, type ArchiveStatus } from '@shared/archive';
import { shownText } from '../store';
import { byteSize } from '../lib/format';
import { HoverTip } from './ChartTip';
import { migrating, migrationLabel, MIGRATION_NOTE } from './ActivityImport';
import { Dialog, Notice, NumberField, SettingRow, SettingsGroup, Toggle } from './ui';
import { appLocale } from '@shared/timeFormat';

const MiB = 1024 * 1024;
/** Bounds from normalizeArchivePolicy (src/shared/archive.ts). */
const RETENTION_DAYS = { min: 1, max: 90 };
const BUDGET_MIB = { min: 1, max: 1024 };
/** Store health (drops, bytes) changes as traffic arrives. */
const STATUS_POLL_MS = 3_000;
const LIMITS_NOTE = 'Records complete downstream request and response bodies and WebSocket messages. Interrupted transfers and storage failures are reported. Headers and query strings are excluded. Older captures may contain gaps.';
const OVER_BUDGET_NOTE = 'Older captures omitted by the previous body budget. New captures retain complete bodies.';
const STORED_NOTE = 'Bodies are encrypted and compressed. Active captures, the newest conversation and content waiting for ClickHouse can exceed the budget. Delivered bodies follow local retention.';
const DELETE_NOTE ='Deletes every recorded request and response and turns Record bodies off. Activity history and eval cases stay.';

/** Drops, sequence gaps and rejections, shown only when any happened. A restart alone loses nothing. */
function Losses(props: { status: ArchiveStatus }) {
  const s = () => props.status;
  return <>
    <Show when={s().dropped > 0 || s().gaps > 0}>
      <HoverTip title="Dropped" rows={[{ label: 'Dropped', value: s().dropped.toLocaleString(appLocale()) }, { label: 'Sequence gaps', value: s().gaps.toLocaleString(appLocale()) }, { label: 'Proxy restarts', value: s().restarts.toLocaleString(appLocale()) }]}
        note="Captures the proxy could not hand over, from overflow, disconnects or crashes. Gaps overlap drops; don't add them.">
        <span class="badge compact red">{s().dropped ? `${s().dropped.toLocaleString(appLocale())} dropped` : `${s().gaps.toLocaleString(appLocale())} gaps`}</span>
      </HoverTip>
    </Show>
    <Show when={s().overBudgetThreads > 0}>
      <HoverTip title="Over budget" rows={[{ label: 'Conversations', value: s().overBudgetThreads.toLocaleString(appLocale()) }]} note={OVER_BUDGET_NOTE}>
        <span class="badge compact amber">{s().overBudgetThreads.toLocaleString(appLocale())} over budget</span>
      </HoverTip>
    </Show>
    <Show when={s().rejected > 0}>
      <HoverTip title="Rejected" rows={[{ label: 'Records', value: s().rejected.toLocaleString(appLocale()) }]} note="Captures the app refused as malformed or over its limits.">
        <span class="badge compact red">{s().rejected.toLocaleString(appLocale())} rejected</span>
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
      <Show when={status()} fallback={<p class="empty-note" role="status" title={migrating() ? MIGRATION_NOTE : undefined}>{migrating() ? migrationLabel() : 'Loading…'}</p>}>{(s) => <>
        <SettingRow label="Record bodies" help="Keep the text of requests and responses from now on. Time, model, account and status are always kept.">
          <Toggle value={s().policy.captureBodies} disabled={busy()} label="Record bodies" onChange={(captureBodies) => save({ captureBodies })} />
        </SettingRow>
        <SettingRow label="Keep bodies" help="A conversation's text is removed once its newest request is older than this; the requests stay in Activity.">
          <NumberField value={s().policy.retentionDays} {...RETENTION_DAYS} unit="days" onCommit={(retentionDays) => save({ retentionDays })} />
        </SettingRow>
        <SettingRow label="Body budget" help="Counts stored text. When full, the conversation used least recently is removed first.">
          <NumberField value={s().policy.maxBytes / MiB} {...BUDGET_MIB} unit="MiB" onCommit={(n) => save({ maxBytes: n * MiB })} />
        </SettingRow>
        <SettingRow label="Storage">
          <Losses status={s()} />
          <HoverTip title="Storage" rows={[
            { label: 'Exchanges', value: s().entries.toLocaleString(appLocale()) },
            { label: 'With text', value: s().bodies.toLocaleString(appLocale()) },
            { label: 'Conversations', value: s().threads.toLocaleString(appLocale()) },
            { label: 'Text size', value: byteSize(s().bytes) },
            { label: 'Stored', value: byteSize(s().storedBytes) },
            ...s().diffFallbacks ? [{ label: 'Full copies', value: s().diffFallbacks.toLocaleString(appLocale()) }] : [],
            { label: 'Budget', value: byteSize(s().policy.maxBytes) },
            { label: 'Keep bodies', value: `${s().policy.retentionDays} days` },
          ]} note={`${STORED_NOTE} ${LIMITS_NOTE}`}>
            <span class="tabular secondary">{s().bodies.toLocaleString(appLocale())} with text · {byteSize(s().bytes)} text · {byteSize(s().storedBytes)} of {byteSize(s().policy.maxBytes)} stored</span>
          </HoverTip>
        </SettingRow>
        <SettingRow label="Delete recorded bodies" help={DELETE_NOTE}>
          <button class="btn danger" type="button" disabled={busy() || s().entries === 0} onClick={() => setConfirming(true)}>Delete…</button>
        </SettingRow>
        <Show when={s().syncError}>{(e) => <Notice tone="error">Capture sync failed: {shownText(e())}</Notice>}</Show>
        <Show when={s().clearPending}><Notice>Local bodies deleted. Proxy journal deletion is pending and will finish before capture resumes.</Notice></Show>
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
