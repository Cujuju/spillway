import { createResource, createSignal, Match, onCleanup, Show, Switch } from 'solid-js';
import { IS_DEV_BUILD } from '@shared/app';
import type { UpdateInstallMode } from '@shared/settings';
import type { UpdateStatus } from '@shared/types';
import type { UpdateChannel } from '@shared/updateFeed';
import { minuteToClock } from '@shared/windowStartSettings';
import { settings, updateSettings } from '../store';
import { Seg, SettingRow, SettingsGroup, TimeField, Toggle } from './ui';
import { appLocale } from '@shared/timeFormat';

type Of<K extends UpdateStatus['state']> = Extract<UpdateStatus, { state: K }>;

const CHANNEL_OPTIONS: readonly { value: UpdateChannel; label: string; title: string }[] = [
  { value: 'stable', label: 'Stable', title: 'Releases promoted after testing' },
  { value: 'nightly', label: 'Nightly', title: 'A build of every pushed change' },
];

const INSTALL_OPTIONS: readonly { value: UpdateInstallMode; label: string; help: string }[] = [
  { value: 'off', label: 'Off', help: 'Download and install updates yourself, below.' },
  { value: 'now', label: 'Right away', help: 'Download when found, then restart and install. The proxy restarts with the app.' },
  { value: 'scheduled', label: 'At a set time', help: 'Download when found, then restart and install at this time.' },
  { value: 'restart', label: 'Next restart', help: 'Download when found, then install the next time you quit or restart the app.' },
];

/** "0.41.3 (nightly)" for a prerelease. */
const named = (u: { version: string; nightly: boolean }) => `${u.version}${u.nightly ? ' (nightly)' : ''}`;

/** Settings → Updates: channel, automatic check and install, version, check, download and install. Main verifies every file before install. */
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
  const u = () => settings().updates;
  /** When a ready update installs on its own, as a sentence; empty when it waits for the user or installs at once. */
  const installsWhen = () => ({ off: '', now: '', scheduled: ` It installs at ${minuteToClock(u().installMinute)}.`, restart: ' It installs when you quit.' })[u().autoInstall];
  const checkButton = () => <button class="btn" onClick={() => void window.api.checkForUpdates()}>Check for updates</button>;

  return (
    <SettingsGroup>
      <SettingRow label="Channel" help="Nightly gets the latest changes; stable gets tested ones. Switching to stable never downgrades: you stay on this version until stable passes it.">
        <Seg label="Update channel" value={u().channel} options={CHANNEL_OPTIONS} onChange={(v) => void updateSettings((d) => void (d.updates.channel = v))} />
      </SettingRow>
      <SettingRow label="Check automatically" help="Check after launch and every few hours, and notify when an update is found.">
        <Toggle value={u().autoCheck} onChange={(v) => void updateSettings((d) => void (d.updates.autoCheck = v))} />
      </SettingRow>
      <SettingRow label="Install automatically" help={INSTALL_OPTIONS.find((o) => o.value === u().autoInstall)?.help}>
        <Seg label="Install automatically" value={u().autoInstall} options={INSTALL_OPTIONS} onChange={(v) => void updateSettings((d) => void (d.updates.autoInstall = v))} />
      </SettingRow>
      <Show when={u().autoInstall === 'scheduled'}>
        <SettingRow label="Install at" help="Local time, on any day an update is waiting." nested>
          <TimeField value={u().installMinute} onCommit={(m) => void updateSettings((d) => void (d.updates.installMinute = m))} />
        </SettingRow>
      </Show>
      <SettingRow label={`Version ${build()?.version ?? ''}`} help="Updates are verified against this app's signing key before they install.">
        <Switch
          fallback={
            <>
              <Show when={when('up-to-date')}>{(u) => <span class="muted">Up to date · checked {new Date(u().checkedAt).toLocaleTimeString(appLocale())}</span>}</Show>
              {checkButton()}
            </>
          }
        >
          <Match when={when('unavailable')}>{(u) => <span class="muted">{IS_DEV_BUILD ? "The dev build does not update; it runs the repo's code." : u().reason}</span>}</Match>
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
                <span>Version {named(r())} is downloaded and verified.{installsWhen()}</span>
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
