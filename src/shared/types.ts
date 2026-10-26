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
  /** Window length; null when the provider does not say. */
  durationMs: number | null;
  /** Model-, feature- or spend-specific window; only unscoped windows describe the account and drive routing. */
  scoped: boolean;
  /** After a reset: 'fixed' starts the next period at once, 'on_use' with the next request; null when unknown. */
  resetCadence: 'fixed' | 'on_use' | null;
}

export interface CredentialPlan {
  /** Provider tier, e.g. default_claude_max_5x. */
  tier: string;
  /** Short name, e.g. "Max 5x" or "Pro". */
  label: string;
  /** 5-hour session usage relative to Pro (Max 5x = 5); null when unknown. */
  multiplier: number | null;
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
  /** The "use this account" override; it takes traffic ahead of the routing strategy while available. */
  preferred: boolean;
  /** Weighted-round-robin weight; 0 excludes the account from that strategy. */
  weight: number;
  /** Subscription plan from the provider's profile; null when unknown. */
  plan: CredentialPlan | null;
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
  /** credential id → window key → reset time (epoch ms), when known. Absent in samples saved before resets were stored. */
  resets?: Record<string, Record<string, number>>;
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
  /** For outside tools that read the proxy's management API (T3 Code's usage provider). */
  managementKey: string;
  endpoint: string;
}

export interface LogLine {
  at: string;
  stream: 'stdout' | 'stderr' | 'app';
  text: string;
}

/** Recent attempts kept for the Activity page, in main and renderer alike; older ones scroll off. */
export const MAX_ACTIVITY_EVENTS = 500;

/** One upstream attempt from the proxy's live event stream (GET /usage/events). */
export interface ActivityEvent {
  at: string;
  requestId: string;
  /** Attempts of one credential selection share it. */
  selectionId: string | null;
  provider: string;
  model: string;
  authIndex: string | null;
  stream: boolean;
  failed: boolean;
  /** Upstream HTTP status of a failed attempt; null on success. */
  statusCode: number | null;
  error: string | null;
  latencyMs: number;
  /** Time to first token; null when not measured (non-streaming or failed). */
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Cache reads. Claude counts them apart from input; OpenAI includes them in input. */
  cachedTokens: number;
  /** Tokens written to the prompt cache (Claude); 0 where the provider doesn't report them. */
  cacheWriteTokens: number;
}

/** Requests and tokens for one local day, account and model; kept after that day's request log expires. */
export interface ActivityDayTotal {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  provider: string;
  authIndex: string | null;
  model: string;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

/** Coding clients whose own config the Proxy page can point at the proxy. */
export type ClientId = 'claude' | 'codex';
/** out-of-date: applied, but the endpoint or key has changed since (port change, regenerated key). */
export type ClientSetupState = 'not-applied' | 'applied' | 'out-of-date';

export interface ClientSetupStatus {
  client: ClientId;
  state: ClientSetupState;
  /** Config file, with the home folder shown as ~. */
  path: string;
  /** Why the file could not be read; null when it could. */
  error: string | null;
}

/** An app running the client: it keeps the settings it started with. */
export interface ClientProcess {
  pid: number;
  app: string;
}

export interface ClientSetupResult {
  statuses: ClientSetupStatus[];
  /** Codex only: apps running a Codex, which keeps its old settings until restarted. Null when the process list could not be read. */
  restart: ClientProcess[] | null;
}

/** Update check and download progress, shown under Settings → Updates. */
export type UpdateStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; checkedAt: string }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  /** Windows: a verified installer waits for Restart and install. */
  | { state: 'ready'; version: string }
  /** macOS: a verified disk image was saved; the user installs it. */
  | { state: 'saved'; version: string; file: string }
  | { state: 'error'; message: string };
