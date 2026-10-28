import { describe, expect, it } from 'vitest';
import { isCodexPoolAuth } from './codexPoolAuth';

const poolLogin = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a.b.c', refresh_token: 'spillway-pool', account_id: null } });

describe('isCodexPoolAuth', () => {
  it('recognises the pool login and nothing else', () => {
    expect(isCodexPoolAuth(poolLogin)).toBe(true);
    expect(isCodexPoolAuth('{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt_user"}}')).toBe(false);
    expect(isCodexPoolAuth('{ nope')).toBe(false);
  });
});
