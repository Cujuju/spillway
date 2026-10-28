import { describe, expect, it } from 'vitest';
import { inScope, normalizeScope } from '@shared/activityScope';
import { accountGroups, NO_ACCOUNT_LABEL, setAccounts } from './accountScope';

const credentials = [
  { authIndex: 'c2', provider: 'codex', label: 'zed@x' },
  { authIndex: 'a1', provider: 'claude', label: 'bob@x' },
  { authIndex: 'a2', provider: 'claude', label: 'amy@x' },
];

describe('accountGroups', () => {
  it('groups by provider A-Z, then removed and saved-only accounts', () => {
    const groups = accountGroups(credentials, [{ authIndex: 'gone', provider: 'claude' }, { authIndex: null, provider: 'codex' }], ['stale']);
    expect(groups.map((g) => [g.provider, g.accounts.map((a) => a.label)])).toEqual([
      ['claude', ['amy@x', 'bob@x', 'gone']],
      ['codex', [NO_ACCOUNT_LABEL, 'zed@x']],
      ['', ['stale']],
    ]);
  });
});

describe('setAccounts', () => {
  const all = ['a1', 'a2', 'c2'];
  it('unticking from every account keeps the rest', () => {
    expect(setAccounts(null, ['a1'], false, all)).toEqual(['a2', 'c2']);
  });
  it('ticking the last missing account means every account again', () => {
    expect(setAccounts(['a2', 'c2'], ['a1'], true, all)).toBeNull();
  });
  it('unticks a whole provider', () => {
    expect(setAccounts(null, ['a1', 'a2'], false, all)).toEqual(['c2']);
  });
});

describe('inScope / normalizeScope', () => {
  it('matches requests without an account by the empty key', () => {
    expect(inScope([''], null)).toBe(true);
    expect(inScope(['a1'], null)).toBe(false);
    expect(inScope(null, 'anything')).toBe(true);
  });
  it('treats anything but a string list as every account', () => {
    expect(normalizeScope(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeScope([1])).toBeNull();
    expect(normalizeScope(undefined)).toBeNull();
  });
});
