import './identity';
import { app, nativeTheme, Notification, session } from 'electron';
import { hasTransferSwitch, runTransferMode } from './dataTransfer';
import { APP_ID, APP_NAME } from '@shared/app';
import { history } from './historyStore';
import { appIconPath } from './paths';
import { getSettings, loadSecrets, onSettingsChange } from './settingsStore';

if (hasTransferSwitch()) void runTransferMode();
else void startNormalApp();

async function startNormalApp(): Promise<void> {
  const { EVENTS } = await import('@shared/ipc');
  const { activityLog } = await import('./activityService');
  const { installAppMenu } = await import('./appMenu');
  const { activity } = await import('./activityStream');
  const { drainActivity } = await import('./activityShutdown');
  const { registerIpc } = await import('./ipc');
  const { startClientDrift } = await import('./clientDriftService');
  const { syncPreferredAccounts } = await import('./preferredAccounts');
  const { proxy } = await import('./proxySupervisor');
  const { destroyTrays, ensureAppTray, taskbarDark } = await import('./tray');
  const { updates } = await import('./updater');
  const { usage } = await import('./usagePoller');
  const { windowStarter } = await import('./windowStarter');
  const { createMainWindow, isQuitting, mainWindow, markQuitting, showMainWindow, syncWindowBackground } = await import('./window');

  /** Windows: passed by the login item so a login launch can start hidden in the tray. */
  const HIDDEN_ARG = '--hidden';
  const isMac = process.platform === 'darwin';

  // Dev loads package.json, which has no version; packaged builds carry it (electron-builder.ts).
  if (!app.isPackaged) app.setVersion(__APP_VERSION__);

  const send = (channel: string, payload: unknown) => mainWindow()?.webContents.send(channel, payload);

  /** Shows the window on a Settings section. A window still loading gets it after load; sent earlier, the renderer misses it. */
  function openSettingsSection(section: string): void {
    showMainWindow();
    const contents = mainWindow()?.webContents;
    if (!contents) return;
    if (contents.isLoading()) contents.once('did-finish-load', () => send(EVENTS.onOpenSettings, section));
    else send(EVENTS.onOpenSettings, section);
  }

  function applyLoginItem(): void {
    if (!app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return;
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
    windowStarter.attach();
    proxy.on('status', (s) => {
      send(EVENTS.onProxyStatus, s);
      if (s.state !== 'running' && !isQuitting()) void activity.stop();
    });
    activityLog.on('reset', () => send(EVENTS.onActivityReset, undefined));
    activityLog.on('progress', (state) => send(EVENTS.onActivityImport, state));
    activity.on('reset', () => send(EVENTS.onActivityReset, undefined));
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
    updates.on('status', (s) => send(EVENTS.onUpdateStatus, s));
    updates.on('found', (version) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: 'Update available', body: `${APP_NAME} ${version} is ready to download in Settings → Updates.`, icon: appIconPath() });
      n.on('click', () => openSettingsSection('updates'));
      n.show();
    });
    onSettingsChange((next, prev) => {
      // The renderer saves whole settings objects, so it must see changes made here (tray account choice).
      send(EVENTS.onSettings, next);
      if (next.general.launchAtLogin !== prev.general.launchAtLogin || next.general.startMinimized !== prev.general.startMinimized) applyLoginItem();
      if (next.general.theme !== prev.general.theme) syncWindowBackground();
      if (next.updates.autoCheck !== prev.updates.autoCheck) updates.setAutoCheck(next.updates.autoCheck);
      if (next.updates.channel !== prev.updates.channel) void updates.check();
      if (next.activity.retentionDays !== prev.activity.retentionDays) void activityLog.call('setRetention', next.activity.retentionDays).catch(console.error);
    });
    // 'system' theme follows the OS light/dark switch.
    nativeTheme.on('updated', () => {
      syncWindowBackground();
      send(EVENTS.onTaskbarDark, taskbarDark());
    });
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    // Windows groups notifications and taskbar entries by this id.
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
    // A window made before startup creates one has no IPC yet (startup can wait on a Keychain prompt), so early requests wait for it.
    let windowCreated = false;
    let showRequested = false;
    const reveal = () => {
      if (windowCreated) showMainWindow();
      else showRequested = true;
    };
    app.on('second-instance', reveal);
    // macOS: clicking the Dock icon reopens the window.
    app.on('activate', reveal);

    void app.whenReady().then(async () => {
      await loadSecrets();
      registerIpc();
      wireEvents();
      installAppMenu(() => openSettingsSection('about'));
      activityLog.start();
      applyLoginItem();
      // The tray is always present: it hosts the limit icons and the hidden-start entry point.
      ensureAppTray();
      const hidden = launchedHidden() && !showRequested;
      if (hidden) app.dock?.hide();
      createMainWindow(!hidden);
      windowCreated = true;
      startClientDrift();
      updates.setAutoCheck(getSettings().updates.autoCheck);
      if (getSettings().proxy.autoStart) await proxy.start();
    });

    app.on('before-quit', (e) => {
      if (isQuitting()) return;
      // Stop the proxy gracefully before the process exits.
      e.preventDefault();
      markQuitting();
      // Writes the renderer's saved view state (localStorage) to disk before exit.
      session.defaultSession.flushStorageData();
      usage.stop();
      history.flush();
      void drainActivity(() => proxy.stop(), (drain) => activity.stop(drain), activityLog).catch(console.error).finally(() => {
        destroyTrays();
        app.quit();
      });
    });

    // Closing the last window keeps running only when close-to-tray is on; window.ts handles the quit.
    app.on('window-all-closed', () => undefined);
  }
}
