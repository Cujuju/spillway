/** IPC contract shared by main, preload and renderer. */
import type { ActivityScope } from './activityScope';
import type { BuildInfo } from './buildInfo';

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

/** A Codex account's rate-limit reset credits as of the proxy's last lookup. */
export interface ResetCredits {
  /** Credits the account holds. */
  available: number;
  /** Credits usable now, i.e. against a limit the account has reached. */
  applicable: number;
  checkedAt: string;
  /** When held credits expire (ISO), soonest first. May be shorter than `available`: some credits never expire, or the list lookup failed. */
  expiries: string[];
}

/** ChatGPT's answer to spending a reset credit: spent, nothing reached, none held, or a replayed request. */
export const RESET_CREDIT_OUTCOMES = ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'] as const;
export type ResetCreditOutcome = (typeof RESET_CREDIT_OUTCOMES)[number];

/** The latest automatic 5-hour window start and failure, for Settings. */
export interface WindowStartStatus {
  lastStart: { credentialId: string; model: string; at: string } | null;
  lastError: { credentialId: string; message: string; at: string } | null;
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
  /** Config-backed upstream key; request counts are since the proxy started. Raw keys never cross IPC. */
  apiKey?: { masked: string; success: number; failed: number } | null;
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
  /** Codex only; null when never reported. Claude has no such credit. */
  resetCredits: ResetCredits | null;
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
  /** The running proxy's version and build, from its management headers; null until it answers. */
  build: BuildInfo | null;
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

/** A model an account serves, from the proxy's model registry. */
export interface CredentialModel {
  id: string;
  displayName: string | null;
  ownedBy: string | null;
}

/** Login files picked for import; `replaced` names overwrote an account that already existed. */
export interface CredentialImportResult {
  imported: string[];
  replaced: string[];
  failed: { name: string; error: string }[];
}

/** Login renewal; `failed` lists accounts whose token refresh errored. */
export interface CredentialRenewResult {
  renewed: number;
  failed: { name: string; error: string }[];
}

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

/** Requests per Activity page load; the list fetches the next page as it scrolls. */
export const ACTIVITY_PAGE_SIZE = 500;

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
  /** The client conversation as the proxy keys it ("claude:<session uuid>"); null when the client sent none. */
  sessionId: string | null;
  /** Account of this conversation's previous attempt on the same model, when it was another one: the prompt cache started over. */
  movedFrom: string | null;
  /** The client's User-Agent header, naming the program that sent the request; null when it sent none. */
  userAgent: string | null;
  /** clientName(userAgent), set when received; null for requests recorded before clients were. */
  client: string | null;
}

/** An attempt as stored. `id` follows the order Spillway recorded attempts and pages the list. */
export interface StoredActivityEvent extends ActivityEvent {
  id: number;
}

export interface ActivityPageQuery {
  /** Local day, YYYY-MM-DD; null for every stored day. */
  day: string | null;
  failedOnly: boolean;
  scope: ActivityScope;
  /** Return attempts older than this id; null for the newest. */
  before: number | null;
}

/** Newest first. */
export interface ActivityPage {
  events: StoredActivityEvent[];
  more: boolean;
}

/** One stored day for the Requests list's section header. */
export interface ActivityDaySummary extends Pick<ActivityCounts, 'requests' | 'failed' | 'costUsd' | 'unpricedRequests'> {
  /** Local day, YYYY-MM-DD. */
  day: string;
  /** Newest attempt counted. Live attempts above it add to the summary. */
  newestId: number;
}

/** Summed requests, tokens and list-price cost (src/shared/modelPrices.ts). */
export interface ActivityCounts {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Cost had every prompt token been billed at the uncached input rate. */
  uncachedCostUsd: number;
  /** Requests whose model has no known price; their cost is not in `costUsd`. */
  unpricedRequests: number;
}

/** Requests and tokens for one local day, account, model and client; kept after that day's request log expires. */
export interface ActivityDayTotal extends ActivityCounts {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  provider: string;
  authIndex: string | null;
  model: string;
  /** Null for requests without a client, including every request before clients were recorded. */
  client: string | null;
}

/** Activity for one local hour, account, model and client. */
export interface ActivityBucket extends ActivityCounts {
  /** Start of the local hour, epoch ms. With `wholeDay`, local midnight. */
  start: number;
  /** The day's request log has expired, so only its daily total remains. */
  wholeDay: boolean;
  provider: string;
  authIndex: string | null;
  model: string;
  client: string | null;
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

/** A client IP with failed management keys (an outside tool such as T3 Code's usage hub; the app itself is exempt). */
export interface ManagementLockout {
  ip: string;
  failures: number;
  /** Total failures that earn the next lockout. */
  failuresAllowed: number;
  /** ISO time; null when not locked out. */
  lockedUntil: string | null;
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
