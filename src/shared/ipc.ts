import type { BuildInfo } from './buildInfo';
import type { AppSettings } from './settings';
import type {
  ActivityBucket, ActivityDayTotal, ActivityEvent, ClientId, ClientSetupResult, ClientSetupStatus, HistorySample, ManagementLockout, LogLine, OAuthStart, OAuthStatus, ProxyKeys, ProxyStatus, UpdateStatus, UsageSnapshot,
} from './types';

/** Renderer-callable API exposed by the preload as `window.api`. */
export interface DesktopApi {
  platform: string;

  /** Spillway's own version and build. */
  appBuild(): Promise<BuildInfo>;
  getSettings(): Promise<AppSettings>;
  setSettings(next: AppSettings): Promise<AppSettings>;

  proxyStatus(): Promise<ProxyStatus>;
  proxyStart(): Promise<void>;
  proxyStop(): Promise<void>;
  proxyRestart(): Promise<void>;
  proxyKeys(): Promise<ProxyKeys>;
  regenerateClientKey(): Promise<ProxyKeys>;
  proxyLogs(): Promise<LogLine[]>;
  clearProxyLogs(): Promise<void>;
  pickProxyExecutable(): Promise<string | null>;
  /** Whether each client's own config points at this proxy with the current endpoint and key. */
  clientSetupStatus(): Promise<ClientSetupStatus[]>;
  applyClientSetup(client: ClientId): Promise<ClientSetupResult>;
  undoClientSetup(client: ClientId): Promise<ClientSetupResult>;
  /** Outside tools locked out of the management API by wrong keys. */
  managementLockouts(): Promise<ManagementLockout[]>;
  /** Lifts every lockout; returns the list after. */
  resetManagementLockouts(): Promise<ManagementLockout[]>;

  updateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  /** Windows: stops the proxy, runs the verified installer and quits. macOS: opens the downloaded disk image. */
  installUpdate(): Promise<void>;

  usageLatest(): Promise<{ snapshot: UsageSnapshot | null; error: string | null }>;
  usageRefresh(credentialId?: string): Promise<UsageSnapshot | null>;
  usageHistory(): Promise<HistorySample[]>;
  clearHistory(): Promise<void>;
  /** Recent attempts across days, oldest first. */
  activityList(): Promise<ActivityEvent[]>;
  /** Local days (YYYY-MM-DD) with stored requests, newest first. */
  activityDays(): Promise<string[]>;
  /** One stored day's requests, oldest first. */
  activityDay(day: string): Promise<ActivityEvent[]>;
  activityTotals(): Promise<ActivityDayTotal[]>;
  /** Hourly activity for the last `days` local days, today included; expired days as daily totals. */
  activityBuckets(days: number): Promise<ActivityBucket[]>;
  /** Deletes recent, stored and total activity. */
  clearActivity(): Promise<void>;

  oauthStart(provider: string): Promise<OAuthStart>;
  oauthStatus(state: string): Promise<OAuthStatus>;
  oauthCancel(state: string): Promise<void>;
  setCredentialDisabled(credentialId: string, disabled: boolean): Promise<void>;
  setCredentialNote(credentialId: string, note: string): Promise<void>;
  setCredentialPriority(credentialId: string, priority: number): Promise<void>;
  deleteCredential(credentialId: string): Promise<void>;

  setLimitTrays(images: { id: string; png1x: string; png2x: string; tooltip: string }[]): Promise<void>;
  setAppTooltip(text: string): Promise<void>;
  /** Whether the taskbar (Windows) or menu bar (macOS) is dark, so tray digits stay readable. */
  taskbarDark(): Promise<boolean>;

  openExternal(url: string): Promise<void>;
  /** userConfig creates config.user.yaml when missing and opens it in the default editor. */
  openPath(which: 'data' | 'config' | 'auths' | 'logs' | 'userConfig'): Promise<void>;
  copyText(text: string): Promise<void>;

  windowMinimize(): void;
  windowToggleMaximize(): void;
  windowClose(): void;
  quit(): void;

  onSnapshot(cb: (s: UsageSnapshot) => void): () => void;
  onUsageError(cb: (message: string) => void): () => void;
  onProxyStatus(cb: (s: ProxyStatus) => void): () => void;
  onProxyLog(cb: (l: LogLine) => void): () => void;
  onMaximized(cb: (maximized: boolean) => void): () => void;
  onNavigate(cb: (page: string) => void): () => void;
  onSettings(cb: (s: AppSettings) => void): () => void;
  onActivity(cb: (e: ActivityEvent) => void): () => void;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
  onTaskbarDark(cb: (dark: boolean) => void): () => void;
}

/** invoke channels: name → method on DesktopApi. */
export const INVOKE = {
  appBuild: 'app:build',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  proxyStatus: 'proxy:status',
  proxyStart: 'proxy:start',
  proxyStop: 'proxy:stop',
  proxyRestart: 'proxy:restart',
  proxyKeys: 'proxy:keys',
  regenerateClientKey: 'proxy:regenerate-key',
  proxyLogs: 'proxy:logs',
  clearProxyLogs: 'proxy:clear-logs',
  pickProxyExecutable: 'proxy:pick-exe',
  clientSetupStatus: 'clients:status',
  applyClientSetup: 'clients:apply',
  undoClientSetup: 'clients:undo',
  updateStatus: 'update:status',
  checkForUpdates: 'update:check',
  downloadUpdate: 'update:download',
  installUpdate: 'update:install',
  usageLatest: 'usage:latest',
  usageRefresh: 'usage:refresh',
  usageHistory: 'usage:history',
  clearHistory: 'usage:clear-history',
  activityList: 'activity:list',
  activityDays: 'activity:days',
  activityDay: 'activity:day',
  activityTotals: 'activity:totals',
  activityBuckets: 'activity:buckets',
  clearActivity: 'activity:clear',
  oauthStart: 'oauth:start',
  oauthStatus: 'oauth:status',
  oauthCancel: 'oauth:cancel',
  setCredentialDisabled: 'cred:disabled',
  setCredentialNote: 'cred:note',
  setCredentialPriority: 'cred:priority',
  deleteCredential: 'cred:delete',
  setLimitTrays: 'tray:limits',
  setAppTooltip: 'tray:tooltip',
  taskbarDark: 'tray:taskbar-dark',
  openExternal: 'shell:external',
  openPath: 'shell:path',
  copyText: 'clipboard:copy',
  managementLockouts: 'mgmt:lockouts',
  resetManagementLockouts: 'mgmt:lockouts-reset',
} as const satisfies Partial<Record<keyof DesktopApi, string>>;

export const SEND = {
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  quit: 'app:quit',
} as const satisfies Partial<Record<keyof DesktopApi, string>>;

export const EVENTS = {
  onSnapshot: 'usage:snapshot',
  onUsageError: 'usage:error',
  onProxyStatus: 'proxy:status-changed',
  onProxyLog: 'proxy:log',
  onMaximized: 'window:maximized',
  onNavigate: 'app:navigate',
  onSettings: 'settings:changed',
  onActivity: 'activity:event',
  onUpdateStatus: 'update:status-changed',
  onTaskbarDark: 'tray:taskbar-dark-changed',
} as const satisfies Partial<Record<keyof DesktopApi, string>>;
