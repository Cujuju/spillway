import { describe, expect, it } from 'vitest';
import { codexPoolAuthJson, codexPoolAuthMatches, codexPoolToken, isCodexPoolAuth } from './codexPoolAuth';

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;

describe('Codex pool login', () => {
  it('is a JWT Codex accepts: header, claims, signature segments and an expiry far ahead', () => {
    const token = codexPoolToken('k1');
    expect(token.split('.')).toHaveLength(3);
    expect(JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString())).toMatchObject({ typ: 'JWT' });
    expect(claimsOf(token).exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('names no account, so Codex skips workspace discovery and the proxy picks the account', () => {
    const auth = JSON.parse(codexPoolAuthJson('k1', 'a@example.com'));
    expect(auth.auth_mode).toBe('chatgpt');
    expect(auth.tokens.account_id).toBeNull();
    for (const token of [auth.tokens.access_token, auth.tokens.id_token]) {
      expect(claimsOf(token)['https://api.openai.com/auth']).not.toHaveProperty('chatgpt_account_id');
    }
  });

  it('names the routed account in the id token, so usage views match it to the hub account', () => {
    const auth = JSON.parse(codexPoolAuthJson('k1', 'a@example.com'));
    expect(claimsOf(auth.tokens.id_token)).toMatchObject({ email: 'a@example.com', 'https://api.openai.com/profile': { email: 'a@example.com' } });
    expect(claimsOf(JSON.parse(codexPoolAuthJson('k1', null)).tokens.id_token).email).toBe('pool@spillway.invalid');
  });

  it('keeps the bearer token (a proxy client key) the same whichever account it names', () => {
    const a = JSON.parse(codexPoolAuthJson('k1', 'a@example.com'));
    const b = JSON.parse(codexPoolAuthJson('k1', 'b@example.com'));
    expect(a.tokens.access_token).toBe(codexPoolToken('k1'));
    expect(b.tokens.access_token).toBe(codexPoolToken('k1'));
  });

  it("matches its own key's login for any account, not another key's", () => {
    expect(codexPoolAuthMatches(codexPoolAuthJson('k1', 'a@example.com'), 'k1')).toBe(true);
    expect(codexPoolAuthMatches(codexPoolAuthJson('k1', null), 'k1')).toBe(true);
    expect(codexPoolAuthMatches(codexPoolAuthJson('k2', 'a@example.com'), 'k1')).toBe(false);
    expect(codexPoolAuthMatches('{ nope', 'k1')).toBe(false);
  });

  it('is stable for a key and changes with it, so regenerating the key retires the old token', () => {
    expect(codexPoolToken('k1')).toBe(codexPoolToken('k1'));
    expect(codexPoolToken('k2')).not.toBe(codexPoolToken('k1'));
    expect(codexPoolToken('k1')).not.toContain('k1');
  });

  it('recognises any key\'s pool login and nothing else', () => {
    expect(isCodexPoolAuth(codexPoolAuthJson('k1', null))).toBe(true);
    expect(isCodexPoolAuth(codexPoolAuthJson('k2', 'a@example.com'))).toBe(true);
    expect(isCodexPoolAuth('{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt_user"}}')).toBe(false);
    expect(isCodexPoolAuth('{ nope')).toBe(false);
  });
});
