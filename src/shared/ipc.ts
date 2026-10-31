export interface ActivityImportState { state: 'idle' | 'importing'; filesDone: number; filesTotal: number; recordsImported: number; error: string | null }
import type { ApiKeyFamily, ApiProviderDraft, ApiProviderGroup, ApiProviderList, ApiProviderTarget, UpstreamModelsRequest } from './apiProviders';
import type { ActivityScope } from './activityScope';
import type { BuildInfo } from './buildInfo';
import type { AppSettings } from './settings';
import type {
  ActivityBucket, ActivityDaySummary, ActivityDayTotal, ActivityPage, ActivityPageQuery, ClientId, CredentialImportResult, CredentialModel, CredentialRenewResult,ClientSetupResult, ClientSetupStatus, HistorySample, ManagementLockout, LogLine, OAuthStart, ObservedSpan, OAuthStatus, ProxyCoverage, ProxyKeys, ProxyStatus, ResetCreditOutcome, StoredActivityEvent, UpdateStatus, UsageSnapshot, WindowStartStatus, WindowSummary,
} from './types';
import type { ManagedPolicyStatus } from './types';

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
  /** Claude Code's machine-wide managed policy; null on platforms without one. */
  managedPolicyStatus(): Promise<ManagedPolicyStatus | null>;
  /** Writes or removes the policy after an administrator prompt; returns the status after. */
  applyManagedPolicy(): Promise<ManagedPolicyStatus | null>;
  undoManagedPolicy(): Promise<ManagedPolicyStatus | null>;
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
  /** Spends one of a Codex account's rate-limit reset credits. */
  useResetCredit(credentialId: string): Promise<ResetCreditOutcome>;
  /** The latest automatic 5-hour window start and failure. */
  windowStartStatus(): Promise<WindowStartStatus>;
  usageHistory(): Promise<HistorySample[]>;
  usageWindowSummaries(): Promise<WindowSummary[]>;
  /** When the app was reading each account's windows, so past gaps tell no use from no reading. */
  usageObservedSpans(): Promise<ObservedSpan[]>;
  clearHistory(): Promise<void>;
  /** One page of stored attempts, newest first. */
  activityPage(query: ActivityPageQuery): Promise<ActivityPage>;
  /** All of one day's attempts, newest first; for orders the database can't page. */
  activityDay(day: string, failedOnly: boolean, scope: ActivityScope): Promise<StoredActivityEvent[]>;
  /** Each local day with stored requests from `accounts`, newest first. */
  activityDaySummaries(scope: ActivityScope): Promise<ActivityDaySummary[]>;
  activityTotals(): Promise<ActivityDayTotal[]>;
  /** Share of local client usage that went through the proxy. */
  activityImportState(): Promise<ActivityImportState>;
  activityCoverage(): Promise<ProxyCoverage>;
  /** Totals for the latest `days` local days; null returns all. */
  activityBuckets(days: number | null): Promise<ActivityBucket[]>;
  /** Deletes recent, stored and total activity. */
  clearActivity(): Promise<void>;
  /** Titles the clients gave these conversations (proxy session IDs); IDs without one are left out. */
  conversationNames(sessionIds: string[]): Promise<Record<string, string>>;
  /** Moves a conversation, and its subagents, to another account of the same provider; its prompt cache starts over. */
  moveConversation(sessionId: string, authIndex: string): Promise<void>;

  oauthStart(provider: string): Promise<OAuthStart>;
  oauthStatus(state: string): Promise<OAuthStatus>;
  oauthCancel(state: string): Promise<void>;
  setCredentialDisabled(credentialId: string, disabled: boolean): Promise<void>;
  setCredentialNote(credentialId: string, note: string): Promise<void>;
  setCredentialPriority(credentialId: string, priority: number): Promise<void>;
  deleteCredential(credentialId: string): Promise<void>;
  /** Asks for login files and adds them as accounts; null when cancelled. */
  importCredentials(): Promise<CredentialImportResult | null>;
  /** Asks where to save the account's login file; the saved path, or null when cancelled. */
  exportCredential(credentialId: string): Promise<string | null>;
  /** Refreshes one account's login token, or every account's when omitted. */
  renewCredentials(credentialId?: string): Promise<CredentialRenewResult>;
  credentialModels(credentialId: string): Promise<CredentialModel[]>;
  /** API-key upstreams from config.user.yaml's `api-keys` section; keys arrive masked. */
  apiProviders(): Promise<ApiProviderList>;
  setApiKeyEnabled(family: ApiKeyFamily, name: string, id: string, enabled: boolean): Promise<ApiProviderGroup[]>;
  /** Adds a group (target null) or updates one, then applies the config; returns the groups after. */
  saveApiProvider(draft: ApiProviderDraft, target: ApiProviderTarget): Promise<ApiProviderGroup[]>;
  deleteApiProvider(family: ApiKeyFamily, name: string): Promise<ApiProviderGroup[]>;
  /** Models the upstream serves, for the editor's model picker. Saved keys stay in the main process. */
  upstreamModels(request: UpstreamModelsRequest): Promise<CredentialModel[]>;

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
  /** Main asks to show a Settings section (an id from the renderer's SettingsSection). */
  onOpenSettings(cb: (section: string) => void): () => void;
  onOpenProxy(cb: () => void): () => void;
  onClientSetupChanged(cb: () => void): () => void;
  onSettings(cb: (s: AppSettings) => void): () => void;
  onActivityImport(cb: (state: ActivityImportState) => void): () => void;
  onActivityReset(cb: () => void): () => void;
  onActivity(cb: (e: StoredActivityEvent) => void): () => void;
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
  managedPolicyStatus: 'clients:managed-policy-status',
  applyManagedPolicy: 'clients:managed-policy-apply',
  undoManagedPolicy: 'clients:managed-policy-undo',
  updateStatus: 'update:status',
  checkForUpdates: 'update:check',
  downloadUpdate: 'update:download',
  installUpdate: 'update:install',
  usageLatest: 'usage:latest',
  usageRefresh: 'usage:refresh',
  useResetCredit: 'usage:use-reset-credit',
  windowStartStatus: 'usage:window-start-status',
  usageHistory: 'usage:history',
  usageWindowSummaries: 'usage:window-summaries',
  usageObservedSpans: 'usage:observed-spans',
  clearHistory: 'usage:clear-history',
  activityPage: 'activity:page',
  activityDay: 'activity:day',
  activityDaySummaries: 'activity:day-summaries',
  activityTotals: 'activity:totals',
  activityImportState: 'activity:import-state',
  activityCoverage: 'activity:coverage',
  activityBuckets: 'activity:buckets',
  clearActivity: 'activity:clear',
  conversationNames: 'activity:conversation-names',
  moveConversation: 'activity:move-conversation',
  oauthStart: 'oauth:start',
  oauthStatus: 'oauth:status',
  oauthCancel: 'oauth:cancel',
  setCredentialDisabled: 'cred:disabled',
  setCredentialNote: 'cred:note',
  setCredentialPriority: 'cred:priority',
  deleteCredential: 'cred:delete',
  importCredentials: 'cred:import',
  exportCredential: 'cred:export',
  renewCredentials: 'cred:renew',
  credentialModels: 'cred:models',
  apiProviders: 'providers:list',
  setApiKeyEnabled: 'providers:key-enabled',
  saveApiProvider: 'providers:save',
  deleteApiProvider: 'providers:delete',
  upstreamModels: 'providers:models',
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
  onOpenSettings: 'app:open-settings',
  onOpenProxy: 'app:open-proxy',
  onClientSetupChanged: 'clients:changed',
  onSettings: 'settings:changed',
  onActivity: 'activity:event',
  onActivityImport: 'activity:import',
  onActivityReset: 'activity:reset',
  onUpdateStatus: 'update:status-changed',
  onTaskbarDark: 'tray:taskbar-dark-changed',
} as const satisfies Partial<Record<keyof DesktopApi, string>>;
