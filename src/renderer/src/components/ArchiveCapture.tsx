import { Show } from 'solid-js';
import type { ArchivePolicy, ArchiveStatus } from '@shared/archive';
import { shownText } from '../store';
import { HoverTip, InfoTip } from './ChartTip';
import { NumberField, SettingRow, Toggle } from './ui';

const MiB = 1024 * 1024;
/** Bounds from normalizeArchivePolicy (src/shared/archive.ts). */
const RETENTION_DAYS = { min: 1, max: 90 };
const BUDGET_MIB = { min: 1, max: 1024 };
const LIMITS_NOTE = 'HTTP: 256 KiB per request and response (gzip, zstd decoded). Codex WebSocket: 128 messages, 64 KiB each, 256 KiB per direction. Truncation is marked. Oldest bodies expire first; up to 20,000 identities remain. The proxy spools in bounded memory, so overflow, disconnects and crashes can lose captures. Bodies are encrypted with the Activity database key.';
const DELETE_NOTE = 'Deletes every record and turns capture off. Pinned eval cases stay.';

/** Capture policy, store health and deletion. */
export function ArchiveCapture(props: { status?: ArchiveStatus & { syncError?: string | null }; policy: ArchivePolicy; busy: boolean; onSave: (p: ArchivePolicy) => void; onClear: () => void }) {
  const s = () => props.status;
  return (
    <section class="card">
      <div class="panel-head">
        <h2 class="card-title">Capture</h2>
        <InfoTip title="Capture limits" note={LIMITS_NOTE} />
        <div class="panel-head-end">
          <HoverTip title="Delete archive" rows={[]} note={DELETE_NOTE} layout="contents">
            <button class="btn danger" type="button" disabled={props.busy} onClick={() => props.onClear()}>Delete archive</button>
          </HoverTip>
        </div>
      </div>
      <Show when={s()}>{(st) => (
        <div class="stat-strip inset">
          <div class="stat-cell"><div class="stat-label">Records</div><div class="stat-value">{st().entries.toLocaleString()}</div></div>
          <div class="stat-cell"><div class="stat-label">Stored</div><div class="stat-value">{(st().bytes / MiB).toFixed(1)} MiB</div><div class="stat-sub">of {(props.policy.maxBytes / MiB).toLocaleString()} MiB</div></div>
          <HoverTip layout="block" title="Proxy drops" rows={[{ label: 'Sequence gaps', value: st().gaps.toLocaleString() }, { label: 'Epoch changes', value: st().restarts.toLocaleString() }]} note="Gaps overlap drops; don't add them.">
            <div class="stat-cell"><div class="stat-label">Dropped</div><div class="stat-value" classList={{ 'danger-text': st().dropped > 0 }}>{st().dropped.toLocaleString()}</div><div class="stat-sub">{st().gaps.toLocaleString()} gaps</div></div>
          </HoverTip>
          <div class="stat-cell"><div class="stat-label">Rejected</div><div class="stat-value" classList={{ 'danger-text': st().rejected > 0 }}>{st().rejected.toLocaleString()}</div></div>
        </div>
      )}</Show>
      <div class="inspect-rows">
        <SettingRow label="Record bodies" help="Requests and responses from now on. Metadata is always kept.">
          <Toggle value={props.policy.captureBodies} disabled={props.busy} label="Record bodies" onChange={(captureBodies) => props.onSave({ ...props.policy, captureBodies })} />
        </SettingRow>
        <SettingRow label="Keep bodies">
          <NumberField value={props.policy.retentionDays} {...RETENTION_DAYS} unit="days" onCommit={(retentionDays) => props.onSave({ ...props.policy, retentionDays })} />
        </SettingRow>
        <SettingRow label="Body budget">
          <NumberField value={props.policy.maxBytes / MiB} {...BUDGET_MIB} unit="MiB" onCommit={(mib) => props.onSave({ ...props.policy, maxBytes: mib * MiB })} />
        </SettingRow>
      </div>
      <Show when={s()?.syncError}>{(e) => <p class="notice error inspect-notice">Capture sync failed: {shownText(e())}</p>}</Show>
      <Show when={s()?.exportWarning}>{(w) => <p class="notice inspect-notice">Export cleanup: {shownText(w())}</p>}</Show>
    </section>
  );
}
