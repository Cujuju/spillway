import { FolderOpen } from 'lucide-solid';
import { createResource, createSignal, For, Match, Show, Switch } from 'solid-js';
import type { AppSettings, RoutingStrategy } from '@shared/settings';
import { ThemePicker } from '../components/ThemePicker';
import { TrayIconSettings } from '../components/TrayIconSettings';
import { Dialog, NumberField, Seg, SettingRow, Toggle } from '../components/ui';
import { setHistory, settings, updateSettings } from '../store';

const ICON_PX = 14;

type Section = 'general' | 'trayIcons' | 'proxy' | 'dashboard' | 'notifications' | 'advanced';
const NAV: { group: string; items: { id: Section; label: string }[] }[] = [
  { group: 'App', items: [{ id: 'general', label: 'General' }, { id: 'trayIcons', label: 'Tray icons' }, { id: 'notifications', label: 'Notifications' }] },
  { group: 'Proxy', items: [{ id: 'proxy', label: 'Routing & server' }, { id: 'dashboard', label: 'Dashboard' }] },
  { group: 'System', items: [{ id: 'advanced', label: 'Advanced' }] },
];

const STRATEGIES: { value: RoutingStrategy; label: string; help: string }[] = [
  { value: 'soonest-reset', label: 'Soonest reset', help: 'Use the account whose weekly (then 5-hour) limit resets first, so quota that would expire unused gets spent.' },
  { value: 'fill-first', label: 'Fill first', help: 'Stay on one account until it is limited, then move to the next.' },
  { value: 'round-robin', label: 'Round robin', help: 'Rotate through accounts on each request.' },
  { value: 'weighted-round-robin', label: 'Weighted round robin', help: 'Rotate, favouring accounts by weight.' },
];

type Draft = AppSettings;
const set = (fn: (d: Draft) => void) => void updateSettings(fn);

function General() {
  const g = () => settings().general;
  return (
    <>
      <SettingRow label="Launch at login" help="Starts hidden in the tray when you sign in to Windows. Installed builds only.">
        <Toggle value={g().launchAtLogin} onChange={(v) => set((d) => void (d.general.launchAtLogin = v))} />
      </SettingRow>
      <SettingRow label="Start minimized" help="Open to the tray instead of showing the window.">
        <Toggle value={g().startMinimized} onChange={(v) => set((d) => void (d.general.startMinimized = v))} />
      </SettingRow>
      <SettingRow label="Close to tray" help="The close button hides the window; the proxy keeps running. Quit from the tray menu.">
        <Toggle value={g().closeToTray} onChange={(v) => set((d) => void (d.general.closeToTray = v))} />
      </SettingRow>
      <SettingRow label="Minimize to tray" help="Minimizing hides the window from the taskbar.">
        <Toggle value={g().minimizeToTray} onChange={(v) => set((d) => void (d.general.minimizeToTray = v))} />
      </SettingRow>
      <SettingRow label="Confirm before quitting" help="Quitting stops the proxy and any session using it.">
        <Toggle value={g().confirmQuit} onChange={(v) => set((d) => void (d.general.confirmQuit = v))} />
      </SettingRow>
      <SettingRow label="Theme" help="System follows Windows' light or dark mode.">
        <ThemePicker value={g().theme} onChange={(v) => set((d) => void (d.general.theme = v))} />
      </SettingRow>
    </>
  );
}

function ProxySection() {
  const p = () => settings().proxy;
  return (
    <>
      <SettingRow label="Start proxy with the app">
        <Toggle value={p().autoStart} onChange={(v) => set((d) => void (d.proxy.autoStart = v))} />
      </SettingRow>
      <SettingRow label="Restart on crash" help="Backs off between attempts and gives up after repeated crashes.">
        <Toggle value={p().restartOnCrash} onChange={(v) => set((d) => void (d.proxy.restartOnCrash = v))} />
      </SettingRow>
      <SettingRow label="Routing strategy" help={STRATEGIES.find((s) => s.value === p().strategy)?.help}>
        <select class="select" value={p().strategy} onChange={(e) => set((d) => void (d.proxy.strategy = e.currentTarget.value as RoutingStrategy))}>
          <For each={STRATEGIES}>{(s) => <option value={s.value}>{s.label}</option>}</For>
        </select>
      </SettingRow>
      <SettingRow label="Session affinity" help="Keep a conversation on the account it started on, so prompt caches stay warm. New conversations follow the strategy.">
        <Toggle value={p().sessionAffinity} onChange={(v) => set((d) => void (d.proxy.sessionAffinity = v))} />
      </SettingRow>
      <Show when={p().sessionAffinity}>
        <SettingRow nested label="Affinity lifetime" help="An idle conversation is re-routed after this long.">
          <NumberField value={p().sessionAffinityTtlMinutes} suffix="minutes" onCommit={(v) => set((d) => void (d.proxy.sessionAffinityTtlMinutes = v))} />
        </SettingRow>
      </Show>
      <SettingRow label="Port" help="Changing it restarts the proxy; update ANTHROPIC_BASE_URL in your clients.">
        <NumberField value={p().port} onCommit={(v) => set((d) => void (d.proxy.port = v))} />
      </SettingRow>
      <SettingRow label="Allow LAN connections" help="Listen on all interfaces. Other devices still need the client key. Restarts the proxy.">
        <Toggle value={p().allowLan} onChange={(v) => set((d) => void (d.proxy.allowLan = v))} />
      </SettingRow>
      <SettingRow label="Proxy executable" help="Leave empty to use the cli-proxy-api.exe bundled with the app.">
        <input class="input wide mono" readOnly value={p().executablePath} placeholder="Bundled" />
        <button class="btn" onClick={() => void window.api.pickProxyExecutable().then((path) => path && set((d) => void (d.proxy.executablePath = path)))}>Browse…</button>
        <Show when={p().executablePath}>
          <button class="btn ghost" onClick={() => set((d) => void (d.proxy.executablePath = ''))}>Use bundled</button>
        </Show>
      </SettingRow>
    </>
  );
}

function DashboardSection() {
  const db = () => settings().dashboard;
  return (
    <>
      <SettingRow label="Refresh interval" help="How often the app reads limits from the proxy. The proxy looks up live usage on its own schedule.">
        <NumberField value={db().refreshIntervalSeconds} suffix="seconds" onCommit={(v) => set((d) => void (d.dashboard.refreshIntervalSeconds = v))} />
      </SettingRow>
      <SettingRow label="Show emails" help="Off masks account emails, for screenshots and streams.">
        <Toggle value={db().showEmails} onChange={(v) => set((d) => void (d.dashboard.showEmails = v))} />
      </SettingRow>
      <SettingRow label="Forecast length">
        <NumberField value={db().forecastDays} suffix="days" onCommit={(v) => set((d) => void (d.dashboard.forecastDays = v))} />
      </SettingRow>
      <SettingRow label="Drain-rate lookback" help="Recent history used for the %/hour rate and the chart's past line.">
        <NumberField value={db().drainLookbackHours} suffix="hours" onCommit={(v) => set((d) => void (d.dashboard.drainLookbackHours = v))} />
      </SettingRow>
      <SettingRow label="Sort accounts by">
        <Seg value={db().accountSort} options={[{ value: 'reset', label: 'Soonest reset' }, { value: 'usage', label: 'Most left' }, { value: 'name', label: 'Name' }] as const} onChange={(v) => set((d) => void (d.dashboard.accountSort = v))} />
      </SettingRow>
    </>
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
    <For each={rows}>
      {(r) => (
        <SettingRow label={r.label} help={r.help}>
          <Toggle value={n()[r.key]} onChange={(v) => set((d) => void (d.notifications[r.key] = v))} />
        </SettingRow>
      )}
    </For>
  );
}

function Advanced() {
  const [version] = createResource(() => window.api.appVersion());
  const [confirming, setConfirming] = createSignal(false);
  const folders = [
    { which: 'data', label: 'App data', help: 'Settings, encrypted keys and usage history.' },
    { which: 'config', label: 'Proxy config', help: 'The generated config.yaml and proxy log. Rewritten on each start.' },
    { which: 'auths', label: 'Account logins', help: 'OAuth credential files the proxy reads. Keep private.' },
  ] as const;
  return (
    <>
      <For each={folders}>
        {(f) => (
          <SettingRow label={f.label} help={f.help}>
            <button class="btn" onClick={() => void window.api.openPath(f.which)}><FolderOpen size={ICON_PX} /> Open folder</button>
          </SettingRow>
        )}
      </For>
      <SettingRow label="Usage history" help="Stored samples behind the chart and drain rate.">
        <button class="btn danger" onClick={() => setConfirming(true)}>Clear history</button>
      </SettingRow>
      <SettingRow label="Version">
        <span class="mono">{version() ?? ''}</span>
      </SettingRow>
      <Show when={confirming()}>
        <Dialog
          title="Clear usage history?"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button class="btn danger" onClick={() => void window.api.clearHistory().then(() => { setHistory([]); setConfirming(false); })}>Clear</button>
            </>
          }
        >
          <p class="secondary">The chart and drain rate start over. Accounts and settings are kept.</p>
        </Dialog>
      </Show>
    </>
  );
}

export function Settings() {
  const [section, setSection] = createSignal<Section>('general');
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
        <h1 class="dash-title" style={{ 'margin-bottom': '16px' }}>{title()}</h1>
        <div class="card">
          <Switch>
            <Match when={section() === 'general'}><General /></Match>
            <Match when={section() === 'trayIcons'}><TrayIconSettings /></Match>
            <Match when={section() === 'proxy'}><ProxySection /></Match>
            <Match when={section() === 'dashboard'}><DashboardSection /></Match>
            <Match when={section() === 'notifications'}><Notifications /></Match>
            <Match when={section() === 'advanced'}><Advanced /></Match>
          </Switch>
        </div>
      </section>
    </div>
  );
}
