import { Document, isMap, isSeq, parseDocument } from 'yaml';
import { APP_NAME } from '@shared/app';
import type { ApiKeyOrder, AppSettings } from '@shared/settings';

export interface ProxyConfigInput {
  settings: AppSettings['proxy'];
  clientApiKey: string;
  /** Stable management key for outside tools; the proxy stores it bcrypt-hashed. */
  managementKey: string;
  authDir: string;
  /** Text of config.user.yaml; empty when the file does not exist. */
  userConfig: string;
}

export interface ProxyConfigResult {
  yaml: string;
  /** Set when config.user.yaml was unusable and the app-owned config was written alone. */
  userConfigError: string | null;
}

const CONFIG_VERSION = 8;
const LOOPBACK_HOST = '127.0.0.1';
/** Empty host binds every interface (upstream default). */
const ALL_INTERFACES_HOST = '';
const HEADER =
  ` Managed by ${APP_NAME}: regenerated from app settings and config.user.yaml.\n Edit config.user.yaml (v8 layout) for custom keys; the app-owned keys below always win.`;

/** routing.prefer-auth-kind: the credential kind the proxy tries before falling back to the other. */
const PREFERRED_AUTH_KIND: Record<ApiKeyOrder, 'api-key' | 'oauth'> = { first: 'api-key', last: 'oauth' };

/** Go duration string the proxy expects for routing.session-affinity-ttl. */
export const affinityTtl = (minutes: number) => `${minutes}m`;

/** App-owned keys: settings in the app control them, so they override config.user.yaml. */
export function appOwnedValues(input: Omit<ProxyConfigInput, 'userConfig'>): [path: string[], value: unknown][] {
  const p = input.settings;
  return [
    [['config-version'], CONFIG_VERSION],
    [['server', 'host'], p.allowLan ? ALL_INTERFACES_HOST : LOOPBACK_HOST],
    [['server', 'port'], p.port],
    // The app authenticates with a per-launch supervisor password (environment); this key is for outside tools.
    [['management', 'secret-key'], input.managementKey],
    [['management', 'allow-remote'], false],
    [['management', 'disable-control-panel'], true],
    [['routing', 'strategy'], p.strategy],
    [['routing', 'prefer-auth-kind'], PREFERRED_AUTH_KIND[p.apiKeyOrder]],
    [['routing', 'session-affinity'], p.sessionAffinity],
    [['routing', 'session-affinity-ttl'], affinityTtl(p.sessionAffinityTtlMinutes)],
    // A restart keeps conversations on their account (prompt cache) and limited accounts benched.
    [['routing', 'session-affinity-persist'], true],
    [['routing', 'cooldown', 'save-cooldown-status'], true],
    [['requests', 'streaming', 'first-byte-timeout-seconds'], p.firstByteTimeoutSeconds],
    [['oauth', 'auth-dir'], input.authDir],
  ];
}

function parseUserConfig(text: string): { doc: Document; error: string | null } {
  if (!text.trim()) return { doc: new Document({}), error: null };
  const doc = parseDocument(text);
  const [syntaxError] = doc.errors;
  // The first line has the reason and position; the rest is a code frame.
  if (syntaxError) return { doc: new Document({}), error: syntaxError.message.split('\n')[0] ?? syntaxError.message };
  if (doc.contents !== null && !isMap(doc.contents)) return { doc: new Document({}), error: 'config.user.yaml must be a mapping of keys' };
  return { doc, error: null };
}

/** The app's client keys are always accepted; keys the user added in config.user.yaml stay. */
function ensureClientKeys(doc: Document, required: string[]): void {
  const keys = doc.getIn(['access', 'api-keys']);
  if (!isSeq(keys)) {
    doc.setIn(['access', 'api-keys'], required);
    return;
  }
  const present = keys.toJSON() as unknown[];
  for (const key of required) if (!present.includes(key)) keys.add(key);
}

/** Anthropic's "overloaded" status: the model is busy for everyone, so another account would fare no better. */
const OVERLOADED_STATUS = 529;
/** Overload goes back to the client, which retries; the account stays unbenched and the conversation keeps its cache. */
// The proxy skips rules without match text.
export const OVERLOAD_RULE = { status: OVERLOADED_STATUS, match: ['overloaded_error'], action: 'stop' };
const CLAUDE_OAUTH_ERROR_RULES = ['oauth', 'request-scoped-errors', 'claude'];

function ensureOverloadRule(doc: Document): void {
  const rules = doc.getIn(CLAUDE_OAUTH_ERROR_RULES);
  if (!isSeq(rules)) {
    doc.setIn(CLAUDE_OAUTH_ERROR_RULES, [OVERLOAD_RULE]);
    return;
  }
  const present = rules.toJSON() as { status?: unknown }[];
  // The proxy uses the first matching rule.
  if (!present.some((r) => r?.status === OVERLOADED_STATUS)) rules.items.unshift(doc.createNode(OVERLOAD_RULE));
}

/** Builds config.yaml: config.user.yaml with the app-owned keys applied on top. Comments in the user file are kept. */
export function buildProxyConfig(input: ProxyConfigInput): ProxyConfigResult {
  const { doc, error } = parseUserConfig(input.userConfig);
  if (doc.contents === null) doc.contents = doc.createNode({});
  for (const [path, value] of appOwnedValues(input)) doc.setIn(path, value);
  ensureClientKeys(doc, [input.clientApiKey]);
  ensureOverloadRule(doc);
  doc.commentBefore = doc.commentBefore ? `${HEADER}\n\n${doc.commentBefore}` : HEADER;
  return { yaml: doc.toString(), userConfigError: error };
}
