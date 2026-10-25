import { app, nativeTheme, Notification } from 'electron';
import { EVENTS } from '@shared/ipc';
import { activity } from './activityStream';
import { history } from './historyStore';
import { registerIpc } from './ipc';
import { appIconPath } from './paths';
import { syncPreferredAccounts } from './preferredAccounts';
import { proxy } from './proxySupervisor';
import { getSettings, loadSecrets, onSettingsChange } from './settingsStore';
import { destroyTrays, ensureAppTray } from './tray';
import { usage } from './usagePoller';
import { createMainWindow, isQuitting, mainWindow, markQuitting, showMainWindow, syncWindowBackground } from './window';

/** Windows: passed by the login item so a login launch can start hidden in the tray. */
const HIDDEN_ARG = '--hidden';
const isMac = process.platform === 'darwin';

const send = (channel: string, payload: unknown) => mainWindow()?.webContents.send(channel, payload);

function applyLoginItem(): void {
  if (!app.isPackaged) return;
  const g = getSettings().general;
  // Login-item args are Windows-only; macOS detects a login launch with wasOpenedAtLogin instead.
  app.setLoginItemSettings(isMac ? { openAtLogin: g.launchAtLogin } : { openAtLogin: g.launchAtLogin, args: g.startMinimized ? [HIDDEN_ARG] : [] });
}

/** A login launch with "Start minimized" on goes straight to the tray. */
function launchedHidden(): boolean {
  if (isMac) return app.isPackaged && getSettings().general.startMinimized && app.getLoginItemSettings().wasOpenedAtLogin;
  return process.argv.includes(HIDDEN_ARG);
}

function wireEvents(): void {
  usage.on('snapshot', (s) => send(EVENTS.onSnapshot, s));
  usage.on('error', (m) => send(EVENTS.onUsageError, m));
  proxy.on('status', (s) => {
    send(EVENTS.onProxyStatus, s);
    if (s.state !== 'running') activity.stop();
  });
  activity.on('event', (e) => send(EVENTS.onActivity, e));
  proxy.on('log', (l) => send(EVENTS.onProxyLog, l));
  proxy.on('ready', () => {
    activity.start();
    void syncPreferredAccounts().finally(() => usage.start());
  });
  proxy.on('crashed', (code) => {
    usage.stop();
    if (getSettings().notifications.proxyCrashed && Notification.isSupported()) {
      new Notification({ title: 'Proxy stopped unexpectedly', body: `Exit code ${code ?? 'unknown'}`, icon: appIconPath() }).show();
    }
  });
  onSettingsChange((next, prev) => {
    // The renderer saves whole settings objects, so it must see changes made here (tray account choice).
    send(EVENTS.onSettings, next);
    if (next.general.launchAtLogin !== prev.general.launchAtLogin || next.general.startMinimized !== prev.general.startMinimized) applyLoginItem();
    if (next.general.theme !== prev.general.theme) syncWindowBackground();
  });
  // 'system' theme follows the OS light/dark switch.
  nativeTheme.on('updated', syncWindowBackground);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows groups notifications and taskbar entries by this id.
  if (process.platform === 'win32') app.setAppUserModelId('dev.cujuju.cliproxy-desktop');
  app.on('second-instance', () => showMainWindow());
  // macOS: clicking the Dock icon reopens the window.
  app.on('activate', () => showMainWindow());

  void app.whenReady().then(async () => {
    await loadSecrets();
    registerIpc();
    wireEvents();
    applyLoginItem();
    // The tray is always present: it hosts the limit icons and the hidden-start entry point.
    ensureAppTray();
    const hidden = launchedHidden();
    if (hidden) app.dock?.hide();
    createMainWindow(!hidden);
    if (getSettings().proxy.autoStart) await proxy.start();
  });

  app.on('before-quit', (e) => {
    if (isQuitting()) return;
    // Stop the proxy gracefully before the process exits.
    e.preventDefault();
    markQuitting();
    usage.stop();
    activity.stop();
    history.flush();
    void proxy.stop().finally(() => {
      destroyTrays();
      app.quit();
    });
  });

  // Closing the last window keeps running only when close-to-tray is on; window.ts handles the quit.
  app.on('window-all-closed', () => undefined);
}
