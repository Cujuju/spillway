import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { INVOKE, SEND, type DesktopApi } from '@shared/ipc';
import type { ClientId } from '@shared/types';
import { activityLog } from './activityLog';
import { activity } from './activityStream';
import { applyClient, CLIENT_IDS, clientConfigFiles, clientStatus, undoClient } from './clientSetup';
import { proxyConfigChanged, proxyRestartNeeded, type AppSettings } from '@shared/settings';
import { history } from './historyStore';
import { management } from './managementClient';
import { appPaths, PROXY_EXE_NAME } from './paths';
import { ensureUserConfigFile } from './proxyLaunch';
import { proxy } from './proxySupervisor';
import { requestQuit } from './quit';
import { getSecrets, getSettings, regenerateClientApiKey, setSettings } from './settingsStore';
import { setAppTrayTooltip, syncLimitTrays, taskbarDark } from './tray';
import { updates } from './updater';
import { usage } from './usagePoller';
import { mainWindow } from './window';

type Handlers = { [K in keyof typeof INVOKE]: (...args: Parameters<DesktopApi[K]>) => ReturnType<DesktopApi[K]> | Awaited<ReturnType<DesktopApi[K]>> };

/** Credential actions arrive by id; the management API addresses them by file name. */
function credentialName(id: string): string {
  const c = usage.latest()?.credentials.find((x) => x.id === id);
  if (!c) throw new Error('Account not found; refresh and try again');
  return c.name;
}

const keys = () => ({ clientApiKey: getSecrets().clientApiKey, endpoint: proxy.getStatus().endpoint || `http://127.0.0.1:${getSettings().proxy.port}` });

const clientTarget = () => ({ endpoint: keys().endpoint, key: getSecrets().clientApiKey });
const clientStatuses = () => {
  const files = clientConfigFiles();
  return CLIENT_IDS.map((c) => clientStatus(c, files[c], clientTarget()));
};
/** The id comes from the renderer; only known clients map to a file. */
function clientFile(client: ClientId): string {
  if (!CLIENT_IDS.includes(client)) throw new Error(`Unknown client ${String(client)}`);
  return clientConfigFiles()[client];
}

async function applySettings(next: AppSettings): Promise<AppSettings> {
  const prev = getSettings();
  const saved = setSettings(next);
  if (proxy.isRunning() && proxyRestartNeeded(prev, saved)) {
    await proxy.restart();
  } else if (proxy.isRunning() && proxyConfigChanged(prev, saved)) {
    proxy.applyConfig();
  }
  if (prev.dashboard.refreshIntervalSeconds !== saved.dashboard.refreshIntervalSeconds) usage.start();
  return saved;
}

const OPEN_PATHS = {
  data: () => appPaths.root,
  config: () => appPaths.proxyDir,
  auths: () => appPaths.authDir,
  logs: () => appPaths.proxyDir,
  userConfig: () => ensureUserConfigFile(),
} as const;

const handlers: Handlers = {
  appVersion: () => app.getVersion(),
  getSettings: () => getSettings(),
  setSettings: (next) => applySettings(next),
  proxyStatus: () => proxy.getStatus(),
  proxyStart: () => proxy.start(),
  proxyStop: () => proxy.stop(),
  proxyRestart: () => proxy.restart(),
  proxyKeys: () => keys(),
  regenerateClientKey: async () => {
    await regenerateClientApiKey();
    if (proxy.isRunning()) await proxy.restart();
    return keys();
  },
  proxyLogs: () => proxy.logs.all(),
  clearProxyLogs: () => proxy.logs.clear(),
  pickProxyExecutable: async () => {
    const w = mainWindow();
    // macOS binaries have no extension, so only Windows filters by type.
    const filters = process.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }] : [];
    const opts: Electron.OpenDialogOptions = { title: `Choose ${PROXY_EXE_NAME}`, properties: ['openFile'], filters };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  clientSetupStatus: () => clientStatuses(),
  applyClientSetup: (client) => {
    applyClient(client, clientFile(client), clientTarget());
    return clientStatuses();
  },
  undoClientSetup: (client) => {
    undoClient(client, clientFile(client));
    return clientStatuses();
  },
  updateStatus: () => updates.status(),
  checkForUpdates: () => updates.check(),
  downloadUpdate: () => updates.download(),
  installUpdate: async () => {
    // The installer replaces the bundled proxy binary, which a running proxy keeps locked.
    if (updates.status().state === 'ready') await proxy.stop();
    await updates.install();
  },
  usageLatest: () => ({ snapshot: usage.latest(), error: usage.lastError }),
  usageRefresh: (credentialId) => usage.refresh(credentialId ? usage.latest()?.credentials.find((c) => c.id === credentialId)?.authIndex : undefined),
  usageHistory: () => history.all(),
  clearHistory: () => history.clear(),
  activityList: () => activity.all(),
  activityDays: () => activityLog.days(),
  activityDay: (day) => activityLog.day(day),
  activityTotals: () => activityLog.totalsList(),
  clearActivity: () => activity.clear(),
  oauthStart: async (provider) => {
    const start = await management.startOAuth(provider);
    await shell.openExternal(start.url);
    return start;
  },
  oauthStatus: async (state) => {
    const status = await management.oauthStatus(state);
    if (status.status === 'ok') void usage.refresh().catch(() => usage.poll());
    return status;
  },
  oauthCancel: (state) => management.cancelOAuth(state),
  setCredentialDisabled: async (id, disabled) => {
    await management.setDisabled(credentialName(id), disabled);
    await usage.poll();
  },
  setCredentialNote: async (id, note) => {
    await management.setFields(credentialName(id), { note });
    await usage.poll();
  },
  setCredentialPriority: async (id, priority) => {
    await management.setFields(credentialName(id), { priority });
    await usage.poll();
  },
  deleteCredential: async (id) => {
    await management.deleteCredential(credentialName(id));
    await usage.poll();
  },
  setLimitTrays: (images) => syncLimitTrays(images),
  setAppTooltip: (text) => setAppTrayTooltip(text),
  taskbarDark: () => taskbarDark(),
  openExternal: async (url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
  },
  openPath: async (which) => {
    const target = OPEN_PATHS[which]?.();
    if (target) await shell.openPath(target);
  },
  copyText: (text) => clipboard.writeText(text),
};

export function registerIpc(): void {
  for (const [method, channel] of Object.entries(INVOKE) as [keyof typeof INVOKE, string][]) {
    const handler = handlers[method] as (...args: unknown[]) => unknown;
    ipcMain.handle(channel, (_e, ...args: unknown[]) => handler(...args));
  }
  const fromSender = (e: Electron.IpcMainEvent) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.on(SEND.windowMinimize, (e) => fromSender(e)?.minimize());
  ipcMain.on(SEND.windowToggleMaximize, (e) => {
    const w = fromSender(e);
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.on(SEND.windowClose, (e) => fromSender(e)?.close());
  ipcMain.on(SEND.quit, () => void requestQuit());
}
