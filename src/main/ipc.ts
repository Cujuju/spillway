import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { thinkingTestPlan, thinkingTestRunner, thinkingTests, clearThinkingTests } from './thinkingTestService';
import { evalReplay, forgetEvalExport, importEvalFile, invalidateEval, prepareEvalExport, prepareEvalReplay, saveEvalExport, withEvalDeletion } from './evalService';
import type { Document } from 'yaml';
import type { ApiProviderGroup, ApiProviderList } from '@shared/apiProviders';
import { parseBuildInfo } from '@shared/buildInfo';
import { INVOKE, SEND, type DesktopApi } from '@shared/ipc';
import type { ClientId } from '@shared/types';
import { activityLog, activityImportState, archiveMigrationState } from './activityService';
import { archiveSync } from './archiveSync';
import { clickhouseStatus, saveClickHouse, diagnoseClickHouse, retryClickHouse, clearClickHouse, cancelClickHouse, withClickHousePaused } from './clickhouseService';
import { diagnosticExporter } from './diagnosticService';
import { applyDraft, modelListKey, parseForEdit, readGroups, removeGroup, setKeyEnabled } from './apiProviders';
import { listUpstreamModels } from './upstreamModels';
import { applyClient, CLIENT_IDS, clientConfigFiles, clientStatus, undoClient } from './clientSetup';
import { runningCodexApps } from './codexProcesses';
import { checkClientDrift, clientIntent, clientMonitored, clientTarget } from './clientDriftService';
import { applyManagedPolicy, managedPolicyStatus, undoManagedPolicy } from './managedPolicy';
import { exportLoginFile, importLoginFiles } from './credentialFiles';
import { proxyConfigChanged, proxyRestartNeeded, type AppSettings } from '@shared/settings';
import { history } from './historyStore';
import { management } from './managementClient';
import { appPaths, PROXY_EXE_NAME } from './paths';
import { ensureUserConfigFile, readUserConfig, writeUserConfig } from './proxyLaunch';
import { proxy } from './proxySupervisor';
import { proxyIdentity } from './proxyIdentity';
import { requestQuit } from './quit';
import { getSettings, regenerateClientApiKey, setSettings } from './settingsStore';
import { setAppTrayTooltip, syncLimitTrays, taskbarDark } from './tray';
import { updates } from './updater';
import { usage } from './usagePoller';
import { canaryService } from './canaryService';
import { windowStarter } from './windowStarter';
import { mainWindow } from './window';
import { previewNotice } from './notifier';

type Handlers = { [K in keyof typeof INVOKE]: (...args: Parameters<DesktopApi[K]>) => ReturnType<DesktopApi[K]> | Awaited<ReturnType<DesktopApi[K]>> };

/** Longest preset (1 year); a longer renderer-supplied day count returns everything rather than building a huge day set. */
const MAX_BUCKET_DAYS = 365;

/** Credential actions arrive by id; the management API addresses them by file name. */
function credentialName(id: string): string {
  const c = usage.latest()?.credentials.find((x) => x.id === id);
  if (!c) throw new Error('Account not found; refresh and try again');
  return c.name;
}

const keys = () => {
  const id = proxyIdentity();
  return { clientApiKey: id.clientApiKeys[0]!, managementKey: id.managementKey,
    endpoint: proxy.getStatus().endpoint || `http://127.0.0.1:${getSettings().proxy.port}`, sharedFrom: id.sharedFrom };
};

const clientStatuses = () => {
  const files = clientConfigFiles();
  return CLIENT_IDS.map((c) => ({ ...clientStatus(c, files[c], clientTarget()), monitored: clientMonitored(c) }));
};
const policyStatus = () => {
  const status = managedPolicyStatus(clientTarget());
  return status && { ...status, monitored: clientMonitored('managed-policy') };
};
/** A running Codex keeps its old URLs until restarted. */
async function setupResult(client: ClientId) {
  return { statuses: clientStatuses(), restart: client === 'codex' ? await runningCodexApps() : [] };
}
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
  return getSettings();
}

/** Edits config.user.yaml (kept comments and all), then applies it to a running proxy; returns the groups after. */
function editUserConfig(fn: (doc: Document) => void): ApiProviderGroup[] {
  // A new file starts from the template, so its explanatory header is kept.
  ensureUserConfigFile();
  const doc = parseForEdit(readUserConfig());
  fn(doc);
  writeUserConfig(doc.toString());
  if (proxy.isRunning()) proxy.applyConfig();
  return readGroups(doc);
}

function listApiProviders(): ApiProviderList {
  try {
    return { groups: readGroups(parseForEdit(readUserConfig())), error: null };
  } catch (err) {
    return { groups: [], error: err instanceof Error ? err.message : String(err) };
  }
}

const OPEN_PATHS = {
  data: () => appPaths.root,
  config: () => appPaths.proxyDir,
  auths: () => proxyIdentity().authDir,
  logs: () => appPaths.proxyDir,
  userConfig: () => ensureUserConfigFile(),
} as const;

const handlers: Handlers = {
  evalList: () => activityLog.call('evalList'), evalGet: (id, revision) => activityLog.call('evalGet', id, revision),
  evalCreate: (trace, annotation, bodies) => activityLog.call('evalCreate', randomUUID(), trace, annotation, bodies),
  evalRevise: (id, revision, annotation) => activityLog.call('evalRevise', randomUUID(), id, revision, annotation),
  evalDelete: (id) => { invalidateEval(id); return activityLog.call('evalDelete', id); },
  evalImport: importEvalFile, evalExportPrepare: prepareEvalExport, evalExportSave: saveEvalExport, evalExportDiscard: forgetEvalExport,
  thinkingTestPlan, thinkingTests,
  thinkingTestStart: (id) => thinkingTestRunner.start(id),
  thinkingTestStatus: async (id) => { const saved = Object.values(await thinkingTests()).find((t) => t.id === id); if (!saved) throw new Error('Thinking test not available'); return saved; },
  thinkingTestCancel: (id) => thinkingTestRunner.cancel(id),
  evalReplayPrepare: prepareEvalReplay,
  evalReplayStart: (id) => evalReplay.start(id), evalReplayStatus: (id) => evalReplay.status(id), evalReplayCancel: (id) => evalReplay.cancel(id),
  archiveExportPrepare: (options) => activityLog.call('archiveExportPrepare', options),
  archiveExportStatus: (id) => activityLog.call('archiveExportStatus', id),
  archiveExportCancel: (id) => activityLog.call('archiveExportCancel', id),
  archiveExportSave: async (id) => {
    const job = await activityLog.call('archiveExportStatus', id);
    if (job.state !== 'preview') throw new Error('Prepare a fresh export preview');
    const opts: Electron.SaveDialogOptions = { title: 'Save exported exchanges', defaultPath: 'spillway-exchanges.jsonl', filters: [{ name: 'Exported exchanges (JSON Lines)', extensions: ['jsonl'] }] };
    const w = mainWindow(), result = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    return result.canceled || !result.filePath ? activityLog.call('archiveExportCancel', id) : activityLog.call('archiveExportStart', id, result.filePath);
  },
  diagnosticPrepare: (selection) => diagnosticExporter.prepare(selection),
  diagnosticSave: (token) => diagnosticExporter.save(token),
  diagnosticDiscard: (id) => diagnosticExporter.discard(id),
  appBuild: () => parseBuildInfo(app.getVersion(), __APP_BUILD__, null),
  getSettings: () => getSettings(),
  setSettings: (next) => applySettings(next),
  proxyStatus: () => proxy.getStatus(),
  proxyStart: () => proxy.start(),
  proxyStop: () => proxy.stop(),
  proxyRestart: () => proxy.restart(),
  proxyKeys: () => keys(),
  regenerateClientKey: async () => {
    const { sharedFrom } = proxyIdentity();
    if (sharedFrom) throw new Error(`This build uses ${sharedFrom}'s client key; regenerate it in ${sharedFrom}`);
    await regenerateClientApiKey();
    checkClientDrift();
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
  managementLockouts: () => management.lockouts(),
  resetManagementLockouts: async () => {
    await management.resetLockouts();
    return management.lockouts();
  },
  applyClientSetup: (client) => {
    applyClient(client, clientFile(client), clientTarget());
    clientIntent(client, true);
    return setupResult(client);
  },
  undoClientSetup: (client) => {
    undoClient(client, clientFile(client), clientTarget());
    clientIntent(client, false);
    return setupResult(client);
  },
  managedPolicyStatus: () => policyStatus(),
  applyManagedPolicy: async () => {
    await applyManagedPolicy(clientTarget());
    clientIntent('managed-policy', true);
    return policyStatus();
  },
  undoManagedPolicy: async () => {
    clientIntent('managed-policy', false);
    try {
      await undoManagedPolicy(clientTarget());
    } catch (err) {
      clientIntent('managed-policy', true);
      throw err;
    }
    checkClientDrift();
    return policyStatus();
  },
  updateStatus: () => updates.status(),
  checkForUpdates: () => updates.check(),
  downloadUpdate: () => updates.download(),
  // Quitting stops the proxy (before-quit) before the update replaces its binary.
  installUpdate: () => updates.quitAndInstall(),
  usageLatest: () => ({ snapshot: usage.latest(), error: usage.lastError }),
  usageRefresh: (credentialId) => usage.refresh(credentialId ? usage.latest()?.credentials.find((c) => c.id === credentialId)?.authIndex : undefined),
  useResetCredit: (credentialId) => {
    const authIndex = usage.latest()?.credentials.find((c) => c.id === credentialId)?.authIndex;
    if (!authIndex) throw new Error('Account not found');
    return usage.useResetCredit(authIndex);
  },
  driftQuery: (q) => activityLog.call('driftQuery', q),
  canaryStatus: () => canaryService.status(), canaryRunNow: () => canaryService.runNow(),
  canaryResults: (q) => activityLog.call('canaryResults', q),
  windowStartStatus: () => windowStarter.status(),
  usageHistory: () => history.all(),
  usageWindowSummaries: () => history.summaries(),
  usageObservedSpans: () => history.observed(),
  clearHistory: () => history.clear(),
  activityImportState: () => activityImportState(),
  archiveMigrationState: () => archiveMigrationState(),
  activityPage: (query) => activityLog.call('page', query),
  activityDay: (day, failedOnly, scope) => activityLog.call('day', day, failedOnly, scope),
  activityDaySummaries: (scope) => activityLog.call('daySummaries', scope),
  activityTotals: () => activityLog.call('totalsList'),
  activityThinking: async (q) => {
    const credentials = usage.latest()?.credentials ?? [];
    const lists = await Promise.all(credentials.map(async (c) => {
      try { return (await management.credentialModels(c.name)).map((m) => ({ ...m, provider: c.provider })); }
      catch (error) { console.error('Thinking credential models failed', c.name, error); return []; }
    }));
    return activityLog.call('thinking', q, lists.flat());
  },
  activityCompare: (q) => activityLog.call('compare', q),
  activityCoverage: () => activityLog.call('coverage'),
  traceQuery: (q) => activityLog.call('traceQuery', q ?? {}),
  traceAttempts: (q) => activityLog.call('traceAttempts', q),
  archiveDetail: (id) => activityLog.call('archiveDetail', id),
  archiveStatus: async () => ({ ...await activityLog.call('archiveStatus'), syncError: archiveSync.error }),
  archivePolicy: (p) => withClickHousePaused(async () => { const status = await activityLog.call('archivePolicy', p); await archiveSync.refresh(); return status; }),
  archiveClear: () => withClickHousePaused(async () => { const { policy } = await activityLog.call('archiveStatus'); await activityLog.call('archivePolicy', { ...policy, captureBodies: false }); await archiveSync.refresh(); await activityLog.call('archiveClear'); }),
  clickhouseStatus,
  clickhouseSave: saveClickHouse, clickhouseDiagnose: diagnoseClickHouse, clickhouseRetry: retryClickHouse, clickhouseClear: clearClickHouse,
  clickhouseCancel: () => cancelClickHouse(),
  activityBucketSnapshot: (days) => {
    const n = Math.max(1, Math.floor(Number(days) || 1));
    return activityLog.call('bucketSnapshot', days === null || n > MAX_BUCKET_DAYS ? null : n);
  },
  clearActivity: () => withEvalDeletion(() => clearThinkingTests(() => withClickHousePaused(() => activityLog.call('clear')))),
  conversationNames: (sessionIds) => activityLog.call('names', sessionIds),
  moveConversation: (sessionId, authIndex) => management.moveConversation(String(sessionId), String(authIndex)),
  // The dialog opens the link: a second account for a provider needs a private window, not the signed-in browser.
  oauthStart: (provider) => management.startOAuth(provider),
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
  importCredentials: async () => {
    const result = await importLoginFiles(new Set(usage.latest()?.credentials.map((c) => c.name)));
    if (result && result.imported.length + result.replaced.length > 0) await usage.poll();
    return result;
  },
  exportCredential: (id) => exportLoginFile(credentialName(id)),
  renewCredentials: async (id) => {
    const result = await management.renewCredentials(id ? credentialName(id) : undefined);
    await usage.poll();
    return result;
  },
  credentialModels: (id) => management.credentialModels(credentialName(id)),
  apiProviders: () => listApiProviders(),
  setApiKeyEnabled: (family, name, id, enabled) => editUserConfig((doc) => setKeyEnabled(doc, family, name, id, enabled)),
  saveApiProvider: (draft, target) => editUserConfig((doc) => applyDraft(doc, draft, target)),
  deleteApiProvider: (family, name) => editUserConfig((doc) => removeGroup(doc, family, name)),
  upstreamModels: (request) => listUpstreamModels(request, (t) => modelListKey(parseForEdit(readUserConfig()), t.family, t.name)),
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
  noticePreview: () => previewNotice(),
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
