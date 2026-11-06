import { For, Show } from 'solid-js';
import { deliversTo, MAX_CONSOLE_LINES, MIN_CONSOLE_LINES, type NoticeDelivery, type NoticeStyle } from '@cujuju/electron-notices';
import type { AppSettings } from '@shared/settings';
import { TRAY_NAME } from '../lib/platform';
import { settings, updateSettings } from '../store';
import { Seg, SettingRow, SettingsGroup, Toggle } from './ui';

type Notifications = AppSettings['notifications'];
type EventKey = 'limitHit' | 'limitReset' | 'accountSwitched' | 'proxyCrashed';

const DELIVERIES: readonly { value: NoticeDelivery; label: string; help: string }[] = [
  { value: 'overlay', label: 'Spillway', help: 'Spillway’s own notifications, on top of other apps.' },
  { value: 'system', label: 'System', help: 'Your system’s notifications.' },
  { value: 'both', label: 'Both', help: 'Spillway’s and the system’s.' },
];

const STYLES: readonly { value: NoticeStyle; label: string; help: string }[] = [
  { value: 'tray', label: 'Tray drip', help: `One-line cards stacked by the ${TRAY_NAME}. Hover a card to read all of it.` },
  { value: 'drip', label: 'Top drip', help: 'A dark lip at the top of the screen opens for each notice, then settles.' },
  { value: 'console', label: 'Console', help: `Log lines by the ${TRAY_NAME}, newest at the bottom.` },
];

const LINE_OPTIONS = Array.from({ length: MAX_CONSOLE_LINES - MIN_CONSOLE_LINES + 1 }, (_, i) => {
  const value = MIN_CONSOLE_LINES + i;
  return { value, label: String(value) };
});

const EVENTS: readonly { key: EventKey; label: string; help: string }[] = [
  { key: 'limitHit', label: 'Limit reached', help: 'An account hit a limit.' },
  { key: 'limitReset', label: 'Limit reset', help: 'A limited account is usable again.' },
  { key: 'accountSwitched', label: 'Account switched', help: 'New conversations moved to another account.' },
  { key: 'proxyCrashed', label: 'Proxy crashed', help: 'The proxy exited unexpectedly.' },
];

const set = (fn: (n: Notifications) => void) => void updateSettings((d) => fn(d.notifications));
const helpOf = <T,>(options: readonly { value: T; help: string }[], value: T) => options.find((o) => o.value === value)?.help;

/** Settings → Notifications: where they show, the overlay's look, and which events notify. */
export function NotificationSettings() {
  const n = () => settings().notifications;
  return (
    <>
      <SettingsGroup title="Delivery">
        <SettingRow label="Show with" help={helpOf(DELIVERIES, n().delivery)}>
          <Seg label="Show with" value={n().delivery} options={DELIVERIES} onChange={(v) => set((d) => void (d.delivery = v))} />
        </SettingRow>
        <Show when={deliversTo(n().delivery).overlay}>
          <SettingRow label="Style" help={helpOf(STYLES, n().style)}>
            <Seg label="Style" value={n().style} options={STYLES} onChange={(v) => set((d) => void (d.style = v))} />
          </SettingRow>
          <Show when={n().style === 'drip'}>
            <SettingRow nested label="Resting lip" help="Keep a thin lip at the top of the screen between notices. Click it to reopen the last one.">
              <Toggle value={n().dripLip} onChange={(v) => set((d) => void (d.dripLip = v))} />
            </SettingRow>
          </Show>
          <Show when={n().style === 'console'}>
            <SettingRow nested label="Lines" help="Most notices shown at once.">
              <Seg label="Lines" value={n().consoleLines} options={LINE_OPTIONS} onChange={(v) => set((d) => void (d.consoleLines = v))} />
            </SettingRow>
          </Show>
        </Show>
        <SettingRow label="Preview" help="Shows a sample notice the way you chose. Press again for another kind.">
          <button class="btn" type="button" onClick={() => void window.api.noticePreview()}>Show sample</button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Events">
        <For each={EVENTS}>
          {(r) => (
            <SettingRow label={r.label} help={r.help}>
              <Toggle value={n()[r.key]} onChange={(v) => set((d) => void (d[r.key] = v))} />
            </SettingRow>
          )}
        </For>
      </SettingsGroup>
    </>
  );
}
