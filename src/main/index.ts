import { app, nativeTheme, Notification } from 'electron';
import { EVENTS } from '@shared/ipc';
import { history } from './historyStore';
import { registerIpc } from './ipc';
import { appIconPath } from './paths';
import { proxy } from './proxySupervisor';
import { getSettings, loadSecrets, onSettingsChange } from './settingsStore';
import { destroyTrays, ensureAppTray } from './tray';
import { usage } from './usagePoller';
import { createMainWindow, isQuitting, mainWindow, markQuitting, showMainWindow, syncWindowBackground } from './window';

/** Passed by the login item so a login launch can start hidden in the tray. */
const HIDDEN_ARG = '--hidden';

const send = (channel: string, payload: unknown) => mainWindow()?.webContents.send(channel, payload);

function applyLoginItem(): void {
  if (!app.isPackaged) return;
  const g = getSettings().general;
  app.setLoginItemSettings({ openAtLogin: g.launchAtLogin, args: g.startMinimized ? [HIDDEN_ARG] : [] });
}

function wireEvents(): void {
  usage.on('snapshot', (s) => send(EVENTS.onSnapshot, s));
  usage.on('error', (m) => send(EVENTS.onUsageError, m));
  proxy.on('status', (s) => send(EVENTS.onProxyStatus, s));
  proxy.on('log', (l) => send(EVENTS.onProxyLog, l));
  proxy.on('ready', () => usage.start());
  proxy.on('crashed', (code) => {
    usage.stop();
    if (getSettings().notifications.proxyCrashed && Notification.isSupported()) {
      new Notification({ title: 'Proxy stopped unexpectedly', body: `Exit code ${code ?? 'unknown'}`, icon: appIconPath() }).show();
    }
  });
  onSettingsChange((next, prev) => {
    if (next.general.launchAtLogin !== prev.general.launchAtLogin || next.general.startMinimized !== prev.general.startMinimized) applyLoginItem();
    if (next.general.theme !== prev.general.theme) syncWindowBackground();
  });
  // 'system' theme follows the OS light/dark switch.
  nativeTheme.on('updated', syncWindowBackground);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('dev.cujuju.cliproxy-desktop');
  app.on('second-instance', () => showMainWindow());

  void app.whenReady().then(async () => {
    await loadSecrets();
    registerIpc();
    wireEvents();
    applyLoginItem();
    // The tray is always present: it hosts the limit icons and the hidden-start entry point.
    ensureAppTray();
    const launchedHidden = process.argv.includes(HIDDEN_ARG);
    createMainWindow(!launchedHidden);
    if (getSettings().proxy.autoStart) await proxy.start();
  });

  app.on('before-quit', (e) => {
    if (isQuitting()) return;
    // Stop the proxy gracefully before the process exits.
    e.preventDefault();
    markQuitting();
    usage.stop();
    history.flush();
    void proxy.stop().finally(() => {
      destroyTrays();
      app.quit();
    });
  });

  // Closing the last window keeps running only when close-to-tray is on; window.ts handles the quit.
  app.on('window-all-closed', () => undefined);
}
