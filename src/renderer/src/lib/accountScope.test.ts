import { describe, expect, it } from 'vitest';
import { clientName, inScope, normalizeScope } from '@shared/activityScope';
import { accountGroups, clientOptions, NO_ACCOUNT_LABEL, NO_CLIENT_LABEL, setScopeKeys } from './accountScope';

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

describe('setScopeKeys', () => {
  const all = ['a1', 'a2', 'c2'];
  it('unticking from every account keeps the rest', () => {
    expect(setScopeKeys(null, ['a1'], false, all)).toEqual(['a2', 'c2']);
  });
  it('ticking the last missing account means every account again', () => {
    expect(setScopeKeys(['a2', 'c2'], ['a1'], true, all)).toBeNull();
  });
  it('unticks a whole provider', () => {
    expect(setScopeKeys(null, ['a1', 'a2'], false, all)).toEqual(['c2']);
  });
});

describe('inScope / normalizeScope', () => {
  const row = (authIndex: string | null, client: string | null) => ({ authIndex, client });
  it('matches requests without an account or client by the empty key', () => {
    expect(inScope({ accounts: [''], clients: null }, row(null, 'x'))).toBe(true);
    expect(inScope({ accounts: ['a1'], clients: null }, row(null, 'x'))).toBe(false);
    expect(inScope({ accounts: null, clients: [''] }, row('a1', null))).toBe(true);
    expect(inScope({ accounts: null, clients: null }, row('anything', 'any'))).toBe(true);
  });
  it('needs both the account and the client in scope', () => {
    expect(inScope({ accounts: ['a1'], clients: ['stockapp'] }, row('a1', 'stockapp'))).toBe(true);
    expect(inScope({ accounts: ['a1'], clients: ['stockapp'] }, row('a1', 'claude-cli'))).toBe(false);
  });
  it('treats anything but a string list as every key', () => {
    expect(normalizeScope({ accounts: ['a', 'a', 'b'], clients: [1] })).toEqual({ accounts: ['a', 'b'], clients: null });
    expect(normalizeScope(undefined)).toEqual({ accounts: null, clients: null });
  });
});

describe('clientName', () => {
  it("takes the User-Agent's first product name", () => {
    expect(clientName('claude-cli/2.1.0 (external, sdk-ts)')).toBe('claude-cli');
    expect(clientName('stockapp/0.164.0 (Windows 10.0.19045; x86_64) xterm-256color (stockapp; 0.1.0)')).toBe('stockapp');
    expect(clientName('curl')).toBe('curl');
    expect(clientName('  ')).toBeNull();
    expect(clientName(null)).toBeNull();
  });

  it("names an Agent SDK app by its client-app tag, not the CLI it embeds", () => {
    expect(clientName('claude-cli/2.1.316 (external, sdk-ts, agent-sdk/0.3.276, client-app/stockapp/0.9.1)')).toBe('stockapp');
    expect(clientName('claude-cli/2.1.316 (external, sdk-ts, client-app/chattypop)')).toBe('chattypop');
    expect(clientName('claude-cli/2.1.316 (external, sdk-ts, agent-sdk/0.3.276)')).toBe('claude-cli');
  });
});

describe('clientOptions', () => {
  it('lists seen and saved clients A-Z, unknown last', () => {
    expect(clientOptions([{ client: 'stockapp' }, { client: null }, { client: 'claude-cli' }, { client: 'stockapp' }], ['gone'])).toEqual([
      { key: 'claude-cli', label: 'claude-cli' }, { key: 'gone', label: 'gone' }, { key: 'stockapp', label: 'stockapp' }, { key: '', label: NO_CLIENT_LABEL },
    ]);
  });
});
