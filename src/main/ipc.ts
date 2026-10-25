import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { INVOKE, SEND, type DesktopApi } from '@shared/ipc';
import { proxyRestartNeeded, type AppSettings } from '@shared/settings';
import { history } from './historyStore';
import { management } from './managementClient';
import { appPaths } from './paths';
import { affinityTtl } from './proxyConfig';
import { proxy } from './proxySupervisor';
import { requestQuit } from './quit';
import { getSecrets, getSettings, regenerateClientApiKey, setSettings } from './settingsStore';
import { setAppTrayTooltip, syncLimitTrays } from './tray';
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

async function applySettings(next: AppSettings): Promise<AppSettings> {
  const prev = getSettings();
  const saved = setSettings(next);
  const routingChanged = prev.proxy.strategy !== saved.proxy.strategy || prev.proxy.sessionAffinity !== saved.proxy.sessionAffinity ||
    prev.proxy.sessionAffinityTtlMinutes !== saved.proxy.sessionAffinityTtlMinutes;
  if (proxy.isRunning() && proxyRestartNeeded(prev, saved)) {
    await proxy.restart();
  } else if (proxy.isRunning() && routingChanged) {
    // Live update; the regenerated config.yaml carries the same values on the next start.
    await management
      .setRouting(saved.proxy.strategy, saved.proxy.sessionAffinity, affinityTtl(saved.proxy.sessionAffinityTtlMinutes))
      .catch(() => proxy.restart());
  }
  if (prev.dashboard.refreshIntervalSeconds !== saved.dashboard.refreshIntervalSeconds) usage.start();
  return saved;
}

const OPEN_PATHS = {
  data: () => appPaths.root,
  config: () => appPaths.proxyDir,
  auths: () => appPaths.authDir,
  logs: () => appPaths.proxyDir,
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
    const opts: Electron.OpenDialogOptions = { title: 'Choose cli-proxy-api.exe', properties: ['openFile'], filters: [{ name: 'Executable', extensions: ['exe'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  usageLatest: () => ({ snapshot: usage.latest(), error: usage.lastError }),
  usageRefresh: (credentialId) => usage.refresh(credentialId ? usage.latest()?.credentials.find((c) => c.id === credentialId)?.authIndex : undefined),
  usageHistory: () => history.all(),
  clearHistory: () => history.clear(),
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
