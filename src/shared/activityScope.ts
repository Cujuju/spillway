/** Which accounts the Activity page shows. Shared so main's queries and the renderer's live updates agree. */

/** Account keys (authIndex, or NO_ACCOUNT_KEY) to show; null shows every account. */
export type AccountScope = string[] | null;

/** Key for requests recorded without an account; authIndex is never empty. */
export const NO_ACCOUNT_KEY = '';

export const accountKey = (authIndex: string | null): string => authIndex ?? NO_ACCOUNT_KEY;

export const inScope = (scope: AccountScope, authIndex: string | null): boolean =>
  scope === null || scope.includes(accountKey(authIndex));

/** Renderer input arrives untyped over IPC and from storage; anything but a string list is every account. */
export function normalizeScope(raw: unknown): AccountScope {
  return Array.isArray(raw) && raw.every((k) => typeof k === 'string') ? [...new Set(raw as string[])] : null;
}

export const isAccountScope = (v: unknown): v is AccountScope => v === null || (Array.isArray(v) && v.every((k) => typeof k === 'string'));
