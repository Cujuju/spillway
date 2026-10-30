import { FolderOpen } from 'lucide-solid';
import { createSignal, For, Match, Show, Switch } from 'solid-js';
import type { ApiKeyOrder, AppSettings, RoutingStrategy, ServerErrorAction } from '@shared/settings';
import { ThemePicker } from '../components/ThemePicker';
import { TrayIconSettings } from '../components/TrayIconSettings';
import { UpdateSettings } from '../components/UpdateSettings';
import { WindowStartSettings } from '../components/WindowStartSettings';
import { RhythmZipSetting } from '../components/RhythmZipSetting';
import { OS_NAME, TASKBAR_NAME, TRAY_NAME } from '../lib/platform';
import { Dialog, NumberField, Seg, SettingRow, SettingsGroup, Toggle } from '../components/ui';
import { setHistory, setSettingsSection as setSection, settings, settingsSection as section, updateSettings, setObservedSpans, setWindowSummaries, type SettingsSection } from '../store';

const ICON_PX = 14;

const NAV: { group: string; items: { id: SettingsSection; label: string }[] }[] = [
  { group: 'App', items: [{ id: 'general', label: 'General' }, { id: 'appearance', label: 'Appearance' }, { id: 'trayIcons', label: 'Tray icons' }, { id: 'notifications', label: 'Notifications' }] },
  { group: 'Proxy', items: [{ id: 'proxy', label: 'Routing & server' }, { id: 'windowStart', label: 'Window starts' }, { id: 'dashboard', label: 'Dashboard' }] },
  { group: 'System', items: [{ id: 'updates', label: 'Updates' }, { id: 'advanced', label: 'Advanced' }] },
];

const STRATEGIES: { value: RoutingStrategy; label: string; help: string }[] = [
  { value: 'soonest-reset', label: 'Soonest reset', help: 'Use the account whose weekly (then 5-hour) limit resets first, so quota that would expire unused gets spent.' },
  { value: 'fill-first', label: 'Fill first', help: 'Stay on one account until it is limited, then move to the next.' },
  { value: 'round-robin', label: 'Round robin', help: 'Rotate through accounts on each request.' },
  { value: 'weighted-round-robin', label: 'Weighted round robin', help: 'Rotate, favouring accounts by weight.' },
];

const API_KEY_ORDERS: readonly { value: ApiKeyOrder; label: string; help: string }[] = [
  { value: 'last', label: 'Use last', help: 'Subscriptions first. API keys take over while every subscription is limited, until one recovers.' },
  { value: 'first', label: 'Use first', help: 'API keys first. Subscriptions take over while every API key is limited or off, until one recovers.' },
];

const SERVER_ERROR_ACTIONS: readonly { value: ServerErrorAction; label: string; help: string }[] = [
  { value: 'stay', label: 'Stay', help: 'Overloads, 5xx errors and dropped connections go back to the client, which retries on the same account. The conversation keeps its prompt cache.' },
  { value: 'switch', label: 'Switch account', help: 'Retry on another account. The conversation moves there and its prompt cache starts over; the failed account rests for a minute.' },
];

type Draft = AppSettings;
const set = (fn: (d: Draft) => void) => void updateSettings(fn);

function General() {
  const g = () => settings().general;
  return (
    <>
      <SettingsGroup title="Startup">
        <SettingRow label="Launch at login" help={`Opens when you sign in to ${OS_NAME}; with Start minimized it stays in the ${TRAY_NAME}. Installed builds only.`}>
          <Toggle value={g().launchAtLogin} onChange={(v) => set((d) => void (d.general.launchAtLogin = v))} />
        </SettingRow>
        <SettingRow label="Start minimized" help={`Open to the ${TRAY_NAME} instead of showing the window.`}>
          <Toggle value={g().startMinimized} onChange={(v) => set((d) => void (d.general.startMinimized = v))} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Window">
        <SettingRow label={`Close to ${TRAY_NAME}`} help={`The close button hides the window; the proxy keeps running. Quit from the ${TRAY_NAME} menu.`}>
          <Toggle value={g().closeToTray} onChange={(v) => set((d) => void (d.general.closeToTray = v))} />
        </SettingRow>
        <SettingRow label={`Minimize to ${TRAY_NAME}`} help={`Minimizing hides the window from the ${TASKBAR_NAME}.`}>
          <Toggle value={g().minimizeToTray} onChange={(v) => set((d) => void (d.general.minimizeToTray = v))} />
        </SettingRow>
        <SettingRow label="Confirm before quitting" help="Quitting stops the proxy and any session using it.">
          <Toggle value={g().confirmQuit} onChange={(v) => set((d) => void (d.general.confirmQuit = v))} />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}

function Appearance() {
  return (
    <SettingsGroup>
      <SettingRow stacked label="Theme" help={`System follows the ${OS_NAME} light or dark mode setting.`}>
        <ThemePicker value={settings().general.theme} onChange={(v) => set((d) => void (d.general.theme = v))} />
      </SettingRow>
    </SettingsGroup>
  );
}

function ProxySection() {
  const p = () => settings().proxy;
  return (
    <>
      <SettingsGroup title="Startup">
        <SettingRow label="Start proxy with the app">
          <Toggle value={p().autoStart} onChange={(v) => set((d) => void (d.proxy.autoStart = v))} />
        </SettingRow>
        <SettingRow label="Restart on crash" help="Backs off between attempts and gives up after repeated crashes.">
          <Toggle value={p().restartOnCrash} onChange={(v) => set((d) => void (d.proxy.restartOnCrash = v))} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Routing">
        <SettingRow label="Routing strategy" help={STRATEGIES.find((s) => s.value === p().strategy)?.help}>
          <select class="select" value={p().strategy} onChange={(e) => set((d) => void (d.proxy.strategy = e.currentTarget.value as RoutingStrategy))}>
            <For each={STRATEGIES}>{(s) => <option value={s.value}>{s.label}</option>}</For>
          </select>
        </SettingRow>
        <SettingRow label="API keys" help={API_KEY_ORDERS.find((o) => o.value === p().apiKeyOrder)?.help}>
          <Seg value={p().apiKeyOrder} options={API_KEY_ORDERS} onChange={(v) => set((d) => void (d.proxy.apiKeyOrder = v))} />
        </SettingRow>
        <SettingRow label="Session affinity" help="Keep a conversation on the account it started on, so prompt caches stay warm. New conversations follow the strategy.">
          <Toggle value={p().sessionAffinity} onChange={(v) => set((d) => void (d.proxy.sessionAffinity = v))} />
        </SettingRow>
        <Show when={p().sessionAffinity}>
          <SettingRow nested label="Affinity lifetime" help="An idle conversation is re-routed after this long.">
            <NumberField value={p().sessionAffinityTtlMinutes} unit="min" onCommit={(v) => set((d) => void (d.proxy.sessionAffinityTtlMinutes = v))} />
          </SettingRow>
          <SettingRow nested label="Wait for a near reset" help="When a conversation's account runs out and resets within this long, the conversation waits for it (T3 Code snoozes) instead of moving, which would re-send its whole context. It only waits while the prompt cache would still be alive at the reset (1 hour for Claude Code). 0 turns it off.">
            <NumberField value={p().sessionHoldMinutes} unit="min" onCommit={(v) => set((d) => void (d.proxy.sessionHoldMinutes = v))} />
          </SettingRow>
        </Show>
        <SettingRow label="On server errors" help={SERVER_ERROR_ACTIONS.find((o) => o.value === p().serverErrors)?.help}>
          <Seg value={p().serverErrors} options={SERVER_ERROR_ACTIONS} onChange={(v) => set((d) => void (d.proxy.serverErrors = v))} />
        </SettingRow>
        <SettingRow label="First-byte timeout" help="A stream that sends nothing for this long is cancelled and handled as a server error. 0 turns it off.">
          <NumberField value={p().firstByteTimeoutSeconds} unit="s" onCommit={(v) => set((d) => void (d.proxy.firstByteTimeoutSeconds = v))} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Server">
        <SettingRow label="Port" help="Changing it restarts the proxy. Re-apply clients on the Proxy page afterwards.">
          <NumberField value={p().port} onCommit={(v) => set((d) => void (d.proxy.port = v))} />
        </SettingRow>
        <SettingRow label="Allow LAN connections" help="Listen on all interfaces. Other devices still need the client key. Restarts the proxy.">
          <Toggle value={p().allowLan} onChange={(v) => set((d) => void (d.proxy.allowLan = v))} />
        </SettingRow>
        <SettingRow stacked label="Proxy executable" help="Leave empty to use the cli-proxy-api binary bundled with the app. A custom binary must be a build that supports MANAGEMENT_SUPERVISOR_PASSWORD, or the app cannot manage it.">
          <input class="input wide tabular" readOnly value={p().executablePath} placeholder="Bundled" />
          <button class="btn" onClick={() => void window.api.pickProxyExecutable().then((path) => path && set((d) => void (d.proxy.executablePath = path)))}>Browse…</button>
          <Show when={p().executablePath}>
            <button class="btn ghost" onClick={() => set((d) => void (d.proxy.executablePath = ''))}>Use bundled</button>
          </Show>
        </SettingRow>
      </SettingsGroup>
    </>
  );
}

function DashboardSection() {
  const db = () => settings().dashboard;
  return (
    <SettingsGroup>
      <RhythmZipSetting />
      <SettingRow label="Refresh interval" help="How often the app reads limits from the proxy. The proxy looks up live usage on its own schedule.">
        <NumberField value={db().refreshIntervalSeconds} unit="s" onCommit={(v) => set((d) => void (d.dashboard.refreshIntervalSeconds = v))} />
      </SettingRow>
      <SettingRow label="Show emails" help="Off masks account emails, for screenshots and streams.">
        <Toggle value={db().showEmails} onChange={(v) => set((d) => void (d.dashboard.showEmails = v))} />
      </SettingRow>
      <SettingRow label="Forecast length">
        <NumberField value={db().forecastHours} unit="h" onCommit={(v) => set((d) => void (d.dashboard.forecastHours = v))} />
      </SettingRow>
      <SettingRow label="Drain-rate lookback" help="Recent history used for the %/hour rate and the chart's default past range.">
        <NumberField value={db().drainLookbackHours} unit="h" onCommit={(v) => set((d) => void (d.dashboard.drainLookbackHours = v))} />
      </SettingRow>
      <SettingRow label="Sort accounts by">
        <Seg value={db().accountSort} options={[{ value: 'reset', label: 'Soonest reset' }, { value: 'usage', label: 'Most left' }, { value: 'name', label: 'Name' }] as const} onChange={(v) => set((d) => void (d.dashboard.accountSort = v))} />
      </SettingRow>
    </SettingsGroup>
  );
}

function Notifications() {
  const n = () => settings().notifications;
  const rows: { key: keyof AppSettings['notifications']; label: string; help: string }[] = [
    { key: 'limitHit', label: 'Limit reached', help: 'An account hit a 5-hour, weekly or other limit.' },
    { key: 'limitReset', label: 'Limit reset', help: 'A limited account is usable again.' },
    { key: 'accountSwitched', label: 'Account switched', help: 'New conversations moved to a different account.' },
    { key: 'proxyCrashed', label: 'Proxy crashed', help: 'The proxy exited unexpectedly.' },
  ];
  return (
    <SettingsGroup>
      <For each={rows}>
        {(r) => (
          <SettingRow label={r.label} help={r.help}>
            <Toggle value={n()[r.key]} onChange={(v) => set((d) => void (d.notifications[r.key] = v))} />
          </SettingRow>
        )}
      </For>
    </SettingsGroup>
  );
}

function Advanced() {
  const [confirming, setConfirming] = createSignal<'usage' | 'activity' | null>(null);
  const folders = [
    { which: 'data', label: 'App data', help: 'Settings, encrypted keys, usage and activity history.' },
    { which: 'config', label: 'Proxy config', help: 'config.yaml (generated from settings and config.user.yaml), config.user.yaml and the proxy log.' },
    { which: 'auths', label: 'Account logins', help: 'OAuth credential files the proxy reads. Keep private.' },
  ] as const;
  return (
    <>
      <SettingsGroup title="Folders">
        <For each={folders}>
          {(f) => (
            <SettingRow label={f.label} help={f.help}>
              <button class="btn" onClick={() => void window.api.openPath(f.which)}><FolderOpen size={ICON_PX} /> Open folder</button>
            </SettingRow>
          )}
        </For>
      </SettingsGroup>
      <SettingsGroup title="History">
        <SettingRow label="Usage history" help="Stored samples behind the chart and drain rate, and each account's past windows.">
          <button class="btn danger" onClick={() => setConfirming('usage')}>Clear history</button>
        </SettingRow>
        <SettingRow label="Keep requests for" help="Days of per-request activity stored on disk. Daily totals are kept until cleared.">
          <NumberField value={settings().activity.retentionDays} unit="d" onCommit={(v) => set((d) => void (d.activity.retentionDays = v))} />
        </SettingRow>
        <SettingRow label="Activity history" help="Stored requests and daily totals behind the Activity page.">
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
          <p class="secondary">Every stored request and daily total is deleted. Accounts and settings are kept.</p>
        </Dialog>
      </Show>
    </>
  );
}

export function Settings() {
  const title = () => NAV.flatMap((g) => g.items).find((i) => i.id === section())?.label ?? '';
  return (
    <div class="settings">
      <nav class="settings-nav">
        <For each={NAV}>
          {(g) => (
            <>
              <div class="sidebar-group">{g.group}</div>
              <For each={g.items}>
                {(i) => <button class="nav-btn" classList={{ active: section() === i.id }} onClick={() => setSection(i.id)}>{i.label}</button>}
              </For>
            </>
          )}
        </For>
      </nav>
      <section class="settings-body">
        <header class="dash-header">
          <h1 class="dash-title">{title()}</h1>
        </header>
        <Switch>
          <Match when={section() === 'general'}><General /></Match>
          <Match when={section() === 'appearance'}><Appearance /></Match>
          <Match when={section() === 'trayIcons'}><TrayIconSettings /></Match>
          <Match when={section() === 'proxy'}><ProxySection /></Match>
          <Match when={section() === 'windowStart'}><WindowStartSettings /></Match>
          <Match when={section() === 'dashboard'}><DashboardSection /></Match>
          <Match when={section() === 'notifications'}><Notifications /></Match>
          <Match when={section() === 'updates'}><UpdateSettings /></Match>
          <Match when={section() === 'advanced'}><Advanced /></Match>
        </Switch>
      </section>
    </div>
  );
}
