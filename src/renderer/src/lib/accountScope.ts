import { accountKey, NO_ACCOUNT_KEY, type AccountScope } from '@shared/activityScope';

/** One account the Activity filter can pick. */
export interface AccountOption {
  key: string;
  /** Empty when only the saved filter knows the account. */
  provider: string;
  label: string;
}

/** Accounts under one provider, in the filter's list. */
export interface AccountGroup {
  provider: string;
  accounts: AccountOption[];
}

export const NO_ACCOUNT_LABEL = 'No account';

/**
 * Current accounts, then accounts seen only in activity (since removed), then keys only the saved
 * filter holds, so every selected account can be unticked. Grouped by provider, A-Z.
 */
export function accountGroups(
  credentials: readonly { authIndex: string; provider: string; label: string }[],
  seen: readonly { authIndex: string | null; provider: string }[],
  scope: AccountScope,
): AccountGroup[] {
  const options = new Map<string, AccountOption>();
  for (const c of credentials) options.set(c.authIndex, { key: c.authIndex, provider: c.provider, label: c.label });
  for (const s of seen) {
    const key = accountKey(s.authIndex);
    if (!options.has(key)) options.set(key, { key, provider: s.provider, label: s.authIndex ?? NO_ACCOUNT_LABEL });
  }
  for (const key of scope ?? []) {
    if (!options.has(key)) options.set(key, { key, provider: '', label: key === NO_ACCOUNT_KEY ? NO_ACCOUNT_LABEL : key });
  }
  const groups = new Map<string, AccountOption[]>();
  for (const o of options.values()) groups.set(o.provider, [...(groups.get(o.provider) ?? []), o]);
  return [...groups]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([provider, accounts]) => ({ provider, accounts: accounts.sort((x, y) => x.label.localeCompare(y.label)) }));
}

/** Ticks or unticks `keys`; ticking every listed account means "every account", so new ones show too. */
export function setAccounts(scope: AccountScope, keys: readonly string[], on: boolean, all: readonly string[]): AccountScope {
  const next = new Set(scope ?? all);
  for (const k of keys) {
    if (on) next.add(k);
    else next.delete(k);
  }
  return all.every((k) => next.has(k)) ? null : [...next];
}
