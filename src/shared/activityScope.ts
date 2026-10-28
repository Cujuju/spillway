/** Which requests the Activity page shows. Shared so main's queries and the renderer's live updates agree. */

/** Keys to show; null shows every one. */
export type KeyScope = string[] | null;
/** Account keys (accountKey). */
export type AccountScope = KeyScope;
/** Client keys (clientKey). */
export type ClientScope = KeyScope;

/** A request shows when both its account and its client are in scope. */
export interface ActivityScope {
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

/** A User-Agent's first product name ("claude-cli/2.1 (…)" → "claude-cli"); null when the client sent none. */
export function clientName(userAgent: string | null): string | null {
  return userAgent?.trim().split(/[\s/]/, 1)[0] || null;
}

const inKeys = (keys: KeyScope, key: string) => keys === null || keys.includes(key);

export const inScope = (scope: ActivityScope, row: { authIndex: string | null; client: string | null }): boolean =>
  inKeys(scope.accounts, accountKey(row.authIndex)) && inKeys(scope.clients, clientKey(row.client));

export const isKeyScope = (v: unknown): v is KeyScope => v === null || (Array.isArray(v) && v.every((k) => typeof k === 'string'));

/** Input arrives untyped over IPC; anything but a string list shows every key. */
const normalizeKeys = (raw: unknown): KeyScope => (Array.isArray(raw) && raw.every((k) => typeof k === 'string') ? [...new Set(raw as string[])] : null);

export function normalizeScope(raw: unknown): ActivityScope {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ActivityScope, unknown>>;
  return { accounts: normalizeKeys(r.accounts), clients: normalizeKeys(r.clients) };
}
