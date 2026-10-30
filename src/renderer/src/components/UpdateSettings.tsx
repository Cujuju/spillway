import { createResource, createSignal, Match, onCleanup, Show, Switch } from 'solid-js';
import type { UpdateStatus } from '@shared/types';
import type { UpdateChannel } from '@shared/updateFeed';
import { settings, updateSettings } from '../store';
import { Seg, SettingRow, SettingsGroup, Toggle } from './ui';

type Of<K extends UpdateStatus['state']> = Extract<UpdateStatus, { state: K }>;

const CHANNEL_OPTIONS: readonly { value: UpdateChannel; label: string; title: string }[] = [
  { value: 'stable', label: 'Stable', title: 'Releases promoted after testing' },
  { value: 'nightly', label: 'Nightly', title: 'A build of every pushed change' },
];

/** "0.41.3 (nightly)" for a prerelease. */
const named = (u: { version: string; nightly: boolean }) => `${u.version}${u.nightly ? ' (nightly)' : ''}`;

/** Settings → Updates: channel, version, check, download and install. Main verifies every file before install. */
export function UpdateSettings() {
  const [build] = createResource(() => window.api.appBuild());
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
    <SettingsGroup>
      <SettingRow label="Channel" help="Nightly gets a build of every pushed change; stable gets the ones promoted after testing. Switching to stable never downgrades: you stay on this version until stable passes it.">
        <Seg label="Update channel" value={settings().updates.channel} options={CHANNEL_OPTIONS} onChange={(v) => void updateSettings((d) => void (d.updates.channel = v))} />
      </SettingRow>
      <SettingRow label="Check automatically" help="Checks shortly after launch and every few hours, and notifies you. Nothing downloads or installs until you choose to.">
        <Toggle value={settings().updates.autoCheck} onChange={(v) => void updateSettings((d) => void (d.updates.autoCheck = v))} />
      </SettingRow>
      <SettingRow label={`Version ${build()?.version ?? ''}`} help="Updates are verified against this app's signing key before they install.">
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
                <span class="list-row-help error">{e().message}</span>
                {checkButton()}
              </>
            )}
          </Match>
          <Match when={when('available')}>
            {(a) => (
              <>
                <span>Version {named(a())} is available.</span>
                <button class="btn primary" onClick={() => void window.api.downloadUpdate()}>Download</button>
              </>
            )}
          </Match>
          <Match when={when('downloading')}>{(d) => <span class="muted">Downloading {named(d())}… {d().percent}%</span>}</Match>
          <Match when={when('ready')}>
            {(r) => (
              <>
                <span>Version {named(r())} is downloaded and verified.</span>
                <button class="btn primary" title="Stops the proxy, installs the update and reopens the app" onClick={() => void window.api.installUpdate()}>
                  Restart and install
                </button>
              </>
            )}
          </Match>
        </Switch>
      </SettingRow>
    </SettingsGroup>
  );
}
