import { FolderInput, FolderOpen, RotateCcw } from 'lucide-solid';
import { createSignal, onMount, Show } from 'solid-js';
import { shownText } from '../store';
import { SettingRow, SettingsGroup } from './ui';

const ICON_PX = 14;

type StorageStatus = Awaited<ReturnType<typeof window.api.activityStorageStatus>>;

/** Settings → Data → Storage: where the Activity and Request capture database lives. */
export function ActivityStorageSettings() {
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
    <SettingsGroup title="Activity storage">
      <SettingRow stacked label="Database folder" help={custom() ? 'Custom location.' : 'Default location, inside the app data folder.'}>
        <input class="input wide tabular" readOnly aria-label="Activity database folder" value={status()?.directory ?? ''} placeholder="Loading…" />
        <button class="btn" disabled={busy() || !status()} onClick={open}><FolderOpen size={ICON_PX} /> Open folder</button>
      </SettingRow>
      <SettingRow label="Move to another folder" help="Choose a drive or folder. Spillway creates a Spillway Data folder there and restarts after moving saved activity, request captures, usage history and proxy console logs. Settings and encryption keys stay in the app data folder.">
        <button class="btn" disabled={busy() || !status()} onClick={() => void move(false)}><FolderInput size={ICON_PX} /> Move…</button>
      </SettingRow>
      <Show when={custom()}>
        <SettingRow label="Use default folder" help={`Moves history and captures back to ${status()!.defaultDirectory}, then restarts Spillway.`}>
          <button class="btn" disabled={busy()} onClick={() => void move(true)}><RotateCcw size={ICON_PX} /> Restore default</button>
        </SettingRow>
      </Show>
      <Show when={error()}><p class="notice error" role="alert">{shownText(error())}</p></Show>
    </SettingsGroup>
  );
}
