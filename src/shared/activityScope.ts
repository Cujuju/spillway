/** Which requests the Activity page shows. Shared so main's queries and the renderer's live updates agree. */

/** Keys to show; null shows every one. */
export type KeyScope = string[] | null;
/** Account keys (accountKey). */
export type AccountScope = KeyScope;
/** Client keys (clientKey). */
export type ClientScope = KeyScope;

/** A request shows when both its account and its client are in scope. */
export interface ActivityScope {
  source?: 'proxy' | 'all';
  accounts: AccountScope;
  clients: ClientScope;
}
export const EVERY_REQUEST: ActivityScope = { accounts: null, clients: null };

/** Key for requests recorded without an account; authIndex is never empty. */
export const NO_ACCOUNT_KEY = '';
/** Key for requests without a client: no User-Agent, or recorded before clients were. clientName is never empty. */
export const NO_CLIENT_KEY = '';

export const accountKey = (authIndex: string | null): string => authIndex ?? NO_ACCOUNT_KEY;
export const clientKey = (client: string | null): string => client ?? NO_CLIENT_KEY;

// Claude Agent SDK apps tag their CLI's User-Agent: "claude-cli/2.1.316 (external, sdk-ts, agent-sdk/0.3.276, client-app/stockapp/0.9.1)".
const CLIENT_APP = /[(\s,]client-app\/([^\s/,;)]+)/;

/** The embedding app's client-app name, else the User-Agent's first product name ("claude-cli/2.1 (…)" → "claude-cli"); null when none was sent. */
export function clientName(userAgent: string | null): string | null {
  const agent = userAgent?.trim();
  if (!agent) return null;
  return CLIENT_APP.exec(agent)?.[1] ?? (agent.split(/[\s/]/, 1)[0] || null);
}

const inKeys = (keys: KeyScope, key: string) => keys === null || keys.includes(key);

export const inScope = (scope: ActivityScope, row: { authIndex: string | null; client: string | null; source?: string }): boolean =>
  (scope.source !== 'proxy' || (row.source ?? 'proxy') === 'proxy') && inKeys(scope.accounts, accountKey(row.authIndex)) && inKeys(scope.clients, clientKey(row.client));

export const isKeyScope = (v: unknown): v is KeyScope => v === null || (Array.isArray(v) && v.every((k) => typeof k === 'string'));

/** Input arrives untyped over IPC; anything but a string list shows every key. */
const normalizeKeys = (raw: unknown): KeyScope => (Array.isArray(raw) && raw.every((k) => typeof k === 'string') ? [...new Set(raw as string[])] : null);

export function normalizeScope(raw: unknown): ActivityScope {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ActivityScope, unknown>>;
  return { accounts: normalizeKeys(r.accounts), clients: normalizeKeys(r.clients), ...(r.source === 'proxy' ? { source: 'proxy' as const } : {}) };
}
