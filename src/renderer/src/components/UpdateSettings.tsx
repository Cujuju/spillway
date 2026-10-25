import { createResource, createSignal, Match, onCleanup, Show, Switch } from 'solid-js';
import type { UpdateStatus } from '@shared/types';
import { isMac } from '../lib/platform';
import { settings, updateSettings } from '../store';
import { SettingRow, Toggle } from './ui';

type Of<K extends UpdateStatus['state']> = Extract<UpdateStatus, { state: K }>;

/** Settings → Updates: version, check, download and install. Main verifies every file before install. */
export function UpdateSettings() {
  const [version] = createResource(() => window.api.appVersion());
  const [status, setStatus] = createSignal<UpdateStatus | null>(null);
  void window.api.updateStatus().then(setStatus);
  onCleanup(window.api.onUpdateStatus(setStatus));

  /** The status when it is in state `k`, typed for that state. */
  const when = <K extends UpdateStatus['state']>(k: K): Of<K> | undefined => {
    const s = status();
    return s?.state === k ? (s as Of<K>) : undefined;
  };
  const checkButton = () => <button class="btn" onClick={() => void window.api.checkForUpdates()}>Check for updates</button>;

  return (
    <>
      <SettingRow label="Check automatically" help="Checks shortly after launch and every few hours, and notifies you. Nothing downloads or installs until you choose to.">
        <Toggle value={settings().updates.autoCheck} onChange={(v) => void updateSettings((d) => void (d.updates.autoCheck = v))} />
      </SettingRow>
      <SettingRow
        label={`Version ${version() ?? ''}`}
        help={`Updates are verified against this app's signing key before they install.${isMac ? ' On macOS, open the downloaded disk image and drag the app to Applications.' : ''}`}
      >
        <Switch
          fallback={
            <>
              <Show when={when('up-to-date')}>{(u) => <span class="muted">Up to date · checked {new Date(u().checkedAt).toLocaleTimeString()}</span>}</Show>
              {checkButton()}
            </>
          }
        >
          <Match when={when('unavailable')}>{(u) => <span class="muted">{u().reason}</span>}</Match>
          <Match when={when('checking')}>
            <span class="muted">Checking…</span>
          </Match>
          <Match when={when('error')}>
            {(e) => (
              <>
                <span class="setting-help error">{e().message}</span>
                {checkButton()}
              </>
            )}
          </Match>
          <Match when={when('available')}>
            {(a) => (
              <>
                <span>Version {a().version} is available.</span>
                <button class="btn primary" onClick={() => void window.api.downloadUpdate()}>Download</button>
              </>
            )}
          </Match>
          <Match when={when('downloading')}>{(d) => <span class="muted">Downloading {d().version}… {d().percent}%</span>}</Match>
          <Match when={when('ready')}>
            {(r) => (
              <>
                <span>Version {r().version} is downloaded and verified.</span>
                <button class="btn primary" title="Stops the proxy, installs the update and reopens the app" onClick={() => void window.api.installUpdate()}>
                  Restart and install
                </button>
              </>
            )}
          </Match>
          <Match when={when('saved')}>
            {(m) => (
              <>
                <span>Version {m().version} is verified and saved to Downloads.</span>
                <button class="btn primary" onClick={() => void window.api.installUpdate()}>Open disk image</button>
              </>
            )}
          </Match>
        </Switch>
      </SettingRow>
    </>
  );
}
