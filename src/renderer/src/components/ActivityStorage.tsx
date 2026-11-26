import { FolderInput, FolderOpen, RotateCcw } from '@/lib/icons';
import { createSignal, For, onMount, Show } from 'solid-js';
import { setHistory, setObservedSpans, setWindowSummaries, settings, shownText, updateSettings } from '../store';
import { Dialog, NumberField, SettingRow, SettingsGroup } from './ui';

const ICON_PX = 14;

type StorageStatus = Awaited<ReturnType<typeof window.api.activityStorageStatus>>;

/** Settings → Data → Storage: folders and local history controls. */
export function ActivityStorageSettings() {
  const [confirming, setConfirming] = createSignal<'usage' | 'activity' | null>(null);
  const folders = [
    { which: 'data', label: 'App data', help: 'Settings, encrypted keys and local app state.' },
    { which: 'config', label: 'Proxy config', help: 'config.yaml (generated from settings and config.user.yaml) and config.user.yaml.' },
    { which: 'auths', label: 'Account logins', help: 'OAuth credential files the proxy reads. Keep private.' },
  ] as const;
  const [status, setStatus] = createSignal<StorageStatus>();
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal('');
  onMount(() => void window.api.activityStorageStatus().then(setStatus).catch((e) => setError(String(e))));
  // Main resolves both paths; equal strings mean the default folder is in use.
  const custom = () => { const s = status(); return !!s && s.directory !== s.defaultDirectory; };
  // Main confirms and restarts on approval; resolving means the user canceled.
  const move = async (useDefault: boolean) => {
    setBusy(true); setError('');
    try { await window.api.moveActivityStorage(useDefault); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const open = () => void window.api.openPath('activityStorage').catch((e) => setError(String(e)));
  return (
    <>
      <SettingsGroup title="Folders">
        <SettingRow stacked label="Database folder" help={custom() ? 'Custom location.' : 'Default location, inside the app data folder.'}>
          <input class="input wide tabular" readOnly aria-label="Activity database folder" value={status()?.directory ?? ''} placeholder="Loading…" />
          <button class="btn" disabled={busy() || !status()} onClick={() => void move(false)}><FolderInput size={ICON_PX} /> Move…</button>
          <button class="btn" disabled={busy() || !status()} onClick={open}><FolderOpen size={ICON_PX} /> Open folder</button>
        </SettingRow>
        <Show when={custom()}>
          <SettingRow label="Use default folder" help={`Moves history and captures back to ${status()!.defaultDirectory}, then restarts Spillway.`}>
            <button class="btn" disabled={busy()} onClick={() => void move(true)}><RotateCcw size={ICON_PX} /> Restore default</button>
          </SettingRow>
        </Show>
        <Show when={error()}><p class="notice error" role="alert">{shownText(error())}</p></Show>
        <For each={folders}>
          {(f) => (
            <SettingRow label={f.label} help={f.help}>
              <button class="btn" onClick={() => void window.api.openPath(f.which)}><FolderOpen size={ICON_PX} /> Open folder</button>
            </SettingRow>
          )}
        </For>
      </SettingsGroup>
      <SettingsGroup title="History">
        <SettingRow label="Usage history" help="Samples behind the chart, drain rate and past windows.">
          <button class="btn danger" onClick={() => setConfirming('usage')}>Clear history</button>
        </SettingRow>
        <SettingRow label="Keep requests for" help="Per-request activity; daily totals stay until cleared.">
          <NumberField value={settings().activity.retentionDays} unit="d" onCommit={(v) => void updateSettings((d) => { d.activity.retentionDays = v; })} />
        </SettingRow>
        <SettingRow label="Activity history" help="Requests and daily totals behind the Activity page.">
          <button class="btn danger" onClick={() => setConfirming('activity')}>Clear history</button>
        </SettingRow>
      </SettingsGroup>
      <Show when={confirming() === 'usage'}>
        <Dialog
          title="Clear usage history?"
          onClose={() => setConfirming(null)}
          actions={
            <>
              <button class="btn" onClick={() => setConfirming(null)}>Cancel</button>
              <button class="btn danger" onClick={() => void window.api.clearHistory().then(() => { setHistory([]); setWindowSummaries([]); setObservedSpans([]); setConfirming(null); })}>Clear</button>
            </>
          }
        >
          <p class="secondary">The chart, drain rate and past windows start over. Accounts and settings are kept.</p>
        </Dialog>
      </Show>
      <Show when={confirming() === 'activity'}>
        <Dialog
          title="Clear activity history?"
          onClose={() => setConfirming(null)}
          actions={
            <>
              <button class="btn" onClick={() => setConfirming(null)}>Cancel</button>
              <button class="btn danger" onClick={() => void window.api.clearActivity().then(() => setConfirming(null))}>Clear</button>
            </>
          }
        >
          <p class="secondary">Every stored request, daily total, recorded body and pinned eval case (all revisions) is deleted. Pending eval exports and replays are canceled. Accounts and settings are kept.</p>
        </Dialog>
      </Show>
    </>
  );
}
