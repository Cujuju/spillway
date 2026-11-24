import { describe, expect, it } from 'vitest';
import { oauthStartQuery, parseCredentialModels, parseRenewAll } from './managementClient';

describe('parseCredentialModels', () => {
  it('maps the proxy rows and drops rows without an id', () => {
    const data = { models: [{ id: 'claude-opus-5-5', display_name: 'Opus 5.5', owned_by: 'anthropic', type: 'claude' }, { id: '' }, { display_name: 'x' }, { id: 'gpt-5.6' }] };
    expect(parseCredentialModels(data)).toEqual([
      { id: 'claude-opus-5-5', displayName: 'Opus 5.5', ownedBy: 'anthropic' },
      { id: 'gpt-5.6', displayName: null, ownedBy: null },
    ]);
  });

  it('returns no models for a malformed body', () => {
    expect(parseCredentialModels(null)).toEqual([]);
    expect(parseCredentialModels({ models: 'nope' })).toEqual([]);
  });
});

describe('parseRenewAll', () => {
  it('counts successes and lists each failure with its reason', () => {
    const data = { ok: true, results: [{ id: 'a.json', success: true }, { id: 'b.json', success: false, error: 'invalid_grant' }, { id: 'c.json', success: false }] };
    expect(parseRenewAll(data)).toEqual({
      renewed: 1,
      failed: [{ name: 'b.json', error: 'invalid_grant' }, { name: 'c.json', error: 'Refresh failed' }],
    });
  });

  it('treats a missing result list as nothing renewed', () => {
    expect(parseRenewAll({ ok: true })).toEqual({ renewed: 0, failed: [] });
  });
});

describe('oauthStartQuery', () => {
  it('starts a new account by provider', () => {
    expect(oauthStartQuery({ provider: 'claude' }).toString()).toBe('provider=claude&is_webui=true');
  });

  it('binds a re-sign-in to the auth file and lets the proxy resolve its provider', () => {
    const q = oauthStartQuery({ name: 'claude-1a2b3c4d-a@b.c.json' });
    expect(q.get('name')).toBe('claude-1a2b3c4d-a@b.c.json');
    expect(q.has('provider')).toBe(false);
  });
});
