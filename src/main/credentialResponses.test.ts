import { describe, expect, it } from 'vitest';
import { parseCredentialModels, parseRenewAll } from './managementClient';

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
