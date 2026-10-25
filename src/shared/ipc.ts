import type { AppSettings } from './settings';
import type {
  ActivityEvent, ClientId, ClientSetupStatus, HistorySample, LogLine, OAuthStart, OAuthStatus, ProxyKeys, ProxyStatus, UsageSnapshot,
} from './types';

/** Renderer-callable API exposed by the preload as `window.api`. */
export interface DesktopApi {
  platform: string;

  appVersion(): Promise<string>;
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
  applyClientSetup(client: ClientId): Promise<ClientSetupStatus[]>;
  undoClientSetup(client: ClientId): Promise<ClientSetupStatus[]>;

  usageLatest(): Promise<{ snapshot: UsageSnapshot | null; error: string | null }>;
  usageRefresh(credentialId?: string): Promise<UsageSnapshot | null>;
  usageHistory(): Promise<HistorySample[]>;
  clearHistory(): Promise<void>;
  activityList(): Promise<ActivityEvent[]>;
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
}

/** invoke channels: name → method on DesktopApi. */
export const INVOKE = {
  appVersion: 'app:version',
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
  usageLatest: 'usage:latest',
  usageRefresh: 'usage:refresh',
  usageHistory: 'usage:history',
  clearHistory: 'usage:clear-history',
  activityList: 'activity:list',
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
  openExternal: 'shell:external',
  openPath: 'shell:path',
  copyText: 'clipboard:copy',
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
} as const satisfies Partial<Record<keyof DesktopApi, string>>;
