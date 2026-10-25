/** IPC contract shared by main, preload and renderer. */

export type ProviderId = string;

export interface LimitWindow {
  /** Stable key from the proxy, e.g. five_hour, seven_day, monthly. */
  key: string;
  label: string;
  /** 0–100; null when the proxy has not observed it yet. */
  usedPercent: number | null;
  resetsAt: string | null;
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
}

export interface Credential {
  id: string;
  /** Auth file name; the management API addresses credentials by it. */
  name: string;
  authIndex: string;
  provider: ProviderId;
  /** User note if set, else the proxy's label, else the email. */
  label: string;
  note: string | null;
  email: string | null;
  lastUsedAt: string | null;
  disabled: boolean;
  status: string;
  statusMessage: string | null;
  priority: number;
  cooldownUntil: string | null;
  observedAt: string | null;
  /** The account the proxy would pick for a new conversation on this provider. */
  nextPick: boolean;
  windows: LimitWindow[];
}

export interface UsageSnapshot {
  fetchedAt: string;
  strategy: string;
  credentials: Credential[];
}

export type ProxyState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'missing-binary' | 'port-busy';

export interface ProxyStatus {
  state: ProxyState;
  pid: number | null;
  port: number;
  startedAt: string | null;
  lastError: string | null;
  executablePath: string | null;
  endpoint: string;
  /** Why config.user.yaml was ignored; null when it applied or does not exist. */
  userConfigError: string | null;
}

/** One stored point of the usage history used for drain rate and the chart. */
export interface HistorySample {
  at: string;
  /** credential id → window key → used percent. */
  used: Record<string, Record<string, number>>;
}

export interface OAuthProvider {
  id: string;
  label: string;
}

export interface OAuthStart {
  state: string;
  url: string;
}

export type OAuthStatus =
  | { status: 'wait' }
  | { status: 'ok' }
  | { status: 'error'; error: string };

export interface ProxyKeys {
  clientApiKey: string;
  endpoint: string;
}

export interface LogLine {
  at: string;
  stream: 'stdout' | 'stderr' | 'app';
  text: string;
}
