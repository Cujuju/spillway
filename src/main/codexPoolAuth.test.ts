import { describe, expect, it } from 'vitest';
import { codexPoolAuthJson, codexPoolToken, isCodexPoolAuth } from './codexPoolAuth';

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;

describe('Codex pool login', () => {
  it('is a JWT Codex accepts: header, claims, signature segments and an expiry far ahead', () => {
    const token = codexPoolToken('k1');
    expect(token.split('.')).toHaveLength(3);
    expect(JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString())).toMatchObject({ typ: 'JWT' });
    expect(claimsOf(token).exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('names no account, so Codex skips workspace discovery and the proxy picks the account', () => {
    const auth = JSON.parse(codexPoolAuthJson('k1'));
    expect(auth.auth_mode).toBe('chatgpt');
    expect(auth.tokens.account_id).toBeNull();
    expect(claimsOf(auth.tokens.access_token)['https://api.openai.com/auth']).not.toHaveProperty('chatgpt_account_id');
  });

  it('is stable for a key and changes with it, so regenerating the key retires the old token', () => {
    expect(codexPoolToken('k1')).toBe(codexPoolToken('k1'));
    expect(codexPoolToken('k2')).not.toBe(codexPoolToken('k1'));
    expect(codexPoolToken('k1')).not.toContain('k1');
  });

  it('recognises any key\'s pool login and nothing else', () => {
    expect(isCodexPoolAuth(codexPoolAuthJson('k1'))).toBe(true);
    expect(isCodexPoolAuth(codexPoolAuthJson('k2'))).toBe(true);
    expect(isCodexPoolAuth('{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt_user"}}')).toBe(false);
    expect(isCodexPoolAuth('{ nope')).toBe(false);
  });
});
