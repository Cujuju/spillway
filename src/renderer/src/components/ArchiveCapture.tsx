import { SlidersHorizontal } from 'lucide-solid';
import { createSignal, createUniqueId, Show } from 'solid-js';
import type { ArchivePolicy, ArchiveStatus } from '@shared/archive';
import { HoverTip, InfoTip } from './ChartTip';
import { NumberField, SettingRow, Toggle } from './ui';

const ICON_PX = 14;
const MiB = 1024 * 1024;
/** Bounds from normalizeArchivePolicy (src/shared/archive.ts). */
const RETENTION_DAYS = { min: 1, max: 90 };
const BUDGET_MIB = { min: 1, max: 1024 };
const LIMITS_NOTE = 'HTTP: 256 KiB per request and response (gzip, zstd decoded). Codex WebSocket: 128 messages, 64 KiB each, 256 KiB per direction. Truncation is marked. Oldest bodies expire first; up to 20,000 identities remain. The proxy spools in bounded memory, so overflow, disconnects and crashes can lose captures. Bodies are encrypted with the Activity database key.';
const DELETE_NOTE = 'Deletes every record and turns capture off. Pinned eval cases stay.';
export const RECORD_BODIES_HELP = 'Requests and responses from now on. Metadata is always kept.';

const mib = (bytes: number) => (bytes / MiB).toLocaleString(undefined, { maximumFractionDigits: 1 });

/** Store health as one line: bodies on or off, records, bytes of the budget, and drops or rejections when any. */
export function CaptureStatus(props: { status: ArchiveStatus }) {
  const s = () => props.status;
  return (
    <span class="capture-status">
      <HoverTip title="Archive" rows={[
        { label: 'Record bodies', value: s().policy.captureBodies ? 'On' : 'Off' },
        { label: 'Records', value: s().entries.toLocaleString() },
        { label: 'Bodies stored', value: `${mib(s().bytes)} MiB` },
        { label: 'Budget', value: `${mib(s().policy.maxBytes)} MiB` },
        { label: 'Keep bodies', value: `${s().policy.retentionDays} days` },
      ]} note={s().policy.captureBodies ? undefined : 'Only metadata is recorded. Turn on Record bodies under Capture.'}>
        <span class="capture-status-line">
          <span class="badge compact" classList={{ green: s().policy.captureBodies }}>{s().policy.captureBodies ? 'Bodies on' : 'Bodies off'}</span>
          <span>{s().entries.toLocaleString()} total</span>
          <span aria-hidden="true">·</span>
          <span>{mib(s().bytes)} of {mib(s().policy.maxBytes)} MiB</span>
        </span>
      </HoverTip>
      <Show when={s().dropped > 0}>
        <HoverTip title="Proxy drops" rows={[{ label: 'Dropped', value: s().dropped.toLocaleString() }, { label: 'Sequence gaps', value: s().gaps.toLocaleString() }, { label: 'Epoch changes', value: s().restarts.toLocaleString() }]}
          note="Captures the proxy could not hand over. Gaps overlap drops; don't add them.">
          <span class="badge compact red">{s().dropped.toLocaleString()} dropped</span>
        </HoverTip>
      </Show>
      <Show when={s().rejected > 0}>
        <HoverTip title="Rejected" rows={[{ label: 'Records', value: s().rejected.toLocaleString() }]} note="Captures the app refused as malformed or over its limits.">
          <span class="badge compact red">{s().rejected.toLocaleString()} rejected</span>
        </HoverTip>
      </Show>
    </span>
  );
}

/** The Capture button and its menu: the capture policy, limits and deletion. */
export function CaptureMenu(props: { policy: ArchivePolicy; busy: boolean; onSave: (p: ArchivePolicy) => void; onClear: () => void }) {
  const id = createUniqueId();
  const anchor = `--capture-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const [confirming, setConfirming] = createSignal(false);
  return (
    <>
      <button type="button" class="btn ghost" popovertarget={id} style={{ 'anchor-name': anchor }}><SlidersHorizontal size={ICON_PX} />Capture</button>
      <div id={id} popover class="account-menu capture-menu" style={{ '--scope-anchor': anchor }} aria-label="Capture"
        onToggle={(e) => { if ((e as ToggleEvent).newState === 'closed') setConfirming(false); }}>
        <div class="capture-menu-head">
          <span class="section-label">Capture</span>
          <InfoTip title="Capture limits" note={LIMITS_NOTE} />
        </div>
        <SettingRow label="Record bodies" help={RECORD_BODIES_HELP}>
          <Toggle value={props.policy.captureBodies} disabled={props.busy} label="Record bodies" onChange={(captureBodies) => props.onSave({ ...props.policy, captureBodies })} />
        </SettingRow>
        <SettingRow label="Keep bodies">
          <NumberField value={props.policy.retentionDays} {...RETENTION_DAYS} narrow unit="days" onCommit={(retentionDays) => props.onSave({ ...props.policy, retentionDays })} />
        </SettingRow>
        <SettingRow label="Body budget">
          <NumberField value={props.policy.maxBytes / MiB} {...BUDGET_MIB} narrow unit="MiB" onCommit={(n) => props.onSave({ ...props.policy, maxBytes: n * MiB })} />
        </SettingRow>
        <div class="capture-menu-foot">
          <Show when={confirming()} fallback={
            <HoverTip title="Delete archive" rows={[]} note={DELETE_NOTE} layout="contents">
              <button class="btn ghost capture-delete" type="button" disabled={props.busy} onClick={() => setConfirming(true)}>Delete archive…</button>
            </HoverTip>
          }>
            <span class="capture-menu-confirm">{DELETE_NOTE}</span>
            <button class="btn ghost" type="button" onClick={() => setConfirming(false)}>Cancel</button>
            <button class="btn danger" type="button" disabled={props.busy} onClick={() => { setConfirming(false); props.onClear(); }}>Delete</button>
          </Show>
        </div>
      </div>
    </>
  );
}
