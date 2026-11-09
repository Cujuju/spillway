import './identity';
import { spillwayNotice } from '@shared/notice';
import { app, nativeTheme, session } from 'electron';
import { hasTransferSwitch, runTransferMode } from './dataTransfer';
import { APP_ID, APP_NAME } from '@shared/app';
import { minuteToClock } from '@shared/windowStartSettings';
import { history } from './historyStore';
import { getSettings, loadSecrets, onSettingsChange } from './settingsStore';
import { HIDDEN_ARG, setLinuxLoginItem } from './linuxLoginItem';

if (hasTransferSwitch()) void runTransferMode();
else void startNormalApp();

async function startNormalApp(): Promise<void> {
  const { EVENTS } = await import('@shared/ipc');
  const { activityLog } = await import('./activityService');
  const { installAppMenu } = await import('./appMenu');
  const { activity } = await import('./activityStream');
  const { archiveSync } = await import('./archiveSync');
  const { clickhouseUploader, cancelClickHouse } = await import('./clickhouseService');
  const { drainActivity } = await import('./activityShutdown');
  const { registerIpc } = await import('./ipc');
  const { stopDiagnosticExport } = await import('./diagnosticService');
  const { invalidateEval } = await import('./evalService');
  const { startClientDrift } = await import('./clientDriftService');
  const { syncPreferredAccounts } = await import('./preferredAccounts');
  const { proxy } = await import('./proxySupervisor');
  const { destroyTrays, ensureAppTray, taskbarDark } = await import('./tray');
  const { updates } = await import('./updater');
  const { startUpdateInstaller } = await import('./updateInstaller');
  const { usage } = await import('./usagePoller');
  const { canaryService } = await import('./canaryService');
  const { windowStarter } = await import('./windowStarter');
  const { createMainWindow, isQuitting, mainWindow, markQuitting, showMainWindow, showWindowAndSend, syncWindowBackground } = await import('./window');
  const { notify, noticeOverlay, startNotices } = await import('./notifier');

  const isMac = process.platform === 'darwin';

  // Dev loads package.json, which has no version; packaged builds carry it (electron-builder.ts).
  if (!app.isPackaged) app.setVersion(__APP_VERSION__);

  const send = (channel: string, payload: unknown) => mainWindow()?.webContents.send(channel, payload);

  const openSettingsSection = (section: string) => showWindowAndSend(EVENTS.onOpenSettings, section);

  function applyLoginItem(): void {
    if (!app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) return;
    const g = getSettings().general;
    if (process.platform === 'linux') return setLinuxLoginItem(g.launchAtLogin, g.startMinimized);
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
    canaryService.on('change', (s) => send(EVENTS.onCanaryChange, s));
    void canaryService.attach().catch((error) => console.error('[canary] startup failed:', error));
    proxy.on('status', (s) => {
      send(EVENTS.onProxyStatus, s);
      if (s.state !== 'running') archiveSync.stop();
      if (s.state !== 'running' && !isQuitting()) void activity.stop();
    });
    activityLog.on('reset', () => send(EVENTS.onActivityReset, undefined));
    activityLog.on('progress', (state) => send(EVENTS.onActivityImport, state));
    activityLog.on('migration', (state) => send(EVENTS.onArchiveMigration, state));
    activity.on('reset', () => send(EVENTS.onActivityReset, undefined));
    activity.on('event', (e) => send(EVENTS.onActivity, e));
    proxy.on('log', (l) => send(EVENTS.onProxyLog, l));
    proxy.on('ready', () => {
      void archiveSync.start();
      activity.start();
      void syncPreferredAccounts().finally(() => usage.start());
    });
    proxy.on('crashed', (code) => {
      usage.stop();
      archiveSync.stop();
      if (getSettings().notifications.proxyCrashed) {
        notify(spillwayNotice('proxyStopped', { target: 'proxy', title: 'Proxy stopped unexpectedly', body: `Exit code ${code ?? 'unknown'}`, short: 'Proxy stopped' }));
      }
    });
    updates.on('status', (s) => send(EVENTS.onUpdateStatus, s));
    updates.on('found', (version) => {
      const { autoInstall, installMinute } = getSettings().updates;
      const time = minuteToClock(installMinute);
      const bodies = {
        off: `${APP_NAME} ${version} is ready to download in Settings → Updates.`,
        now: `${APP_NAME} ${version} is downloading and installs when it is ready.`,
        scheduled: `${APP_NAME} ${version} is downloading and installs at ${time}.`,
        restart: `${APP_NAME} ${version} is downloading and installs the next time ${APP_NAME} quits.`,
      };
      notify(spillwayNotice('updateFound', { target: 'updates', title: 'Update available', body: bodies[autoInstall], short: `${APP_NAME} ${version}` }));
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
      clickhouseUploader.start();
      applyLoginItem();
      // The tray is always present: it hosts the limit icons and the hidden-start entry point.
      ensureAppTray();
      const hidden = launchedHidden() && !showRequested;
      if (hidden) app.dock?.hide();
      createMainWindow(!hidden);
      windowCreated = true;
      startClientDrift();
      startNotices();
      startUpdateInstaller();
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
      invalidateEval();
      archiveSync.stop();
      void Promise.allSettled([
        cancelClickHouse(true).catch(console.error).then(() => drainActivity(() => proxy.stop(), (drain) => activity.stop(drain), activityLog)),
        stopDiagnosticExport(),
      ]).then((results) => { for (const result of results) if (result.status === 'rejected') console.error(result.reason); }).finally(() => {
        destroyTrays();
        noticeOverlay.destroy();
        app.quit();
      });
    });

    // Closing the last window keeps running only when close-to-tray is on; window.ts handles the quit.
    app.on('window-all-closed', () => undefined);
  }
}
