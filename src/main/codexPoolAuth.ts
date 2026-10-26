/**
 * The ChatGPT login Codex reads from auth.json while Spillway serves its account calls (chatgpt_base_url).
 * It names no real account: the proxy sends each call as the pool's routed Codex account.
 */
import { createHash } from 'node:crypto';

/** Codex reads JWT claims without checking the signature, but needs the JWT shape. */
const JWT_HEADER = { alg: 'RS256', typ: 'JWT' };
/** 2100-01-01T00:00:00Z. Fixed, so the token (also a proxy client key) is the same every launch. */
const NEVER_EXPIRES_AT = 4_102_444_800;
const POOL_ID = 'spillway-pool';
const POOL_EMAIL = 'pool@spillway.invalid';
/** Codex requires a plan claim; /wham/usage still reports the routed account's real plan. */
const POOL_PLAN = 'plus';
/** Codex never refreshes this login (verified with a 2020 value); fixed so the file stays byte-identical. */
const LAST_REFRESH = '2020-01-01T00:00:00Z';
/** Codex writes auth.json with two-space indentation. */
const JSON_INDENT = 2;

export const CODEX_AUTH_FILE = 'auth.json';

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Derived from the client key, so regenerating that key retires this token too. */
export function codexPoolToken(clientKey: string): string {
  const claims = {
    iat: 0,
    exp: NEVER_EXPIRES_AT,
    email: POOL_EMAIL,
    // No chatgpt_account_id: Codex then skips workspace discovery and the proxy names the routed account.
    'https://api.openai.com/auth': { chatgpt_plan_type: POOL_PLAN, chatgpt_user_id: POOL_ID, user_id: POOL_ID },
    'https://api.openai.com/profile': { email: POOL_EMAIL, email_verified: true },
  };
  const signature = createHash('sha256').update(clientKey).digest('base64url');
  return `${segment(JWT_HEADER)}.${segment(claims)}.${signature}`;
}

/** True for any pool login, whichever client key it came from. */
export function isCodexPoolAuth(text: string): boolean {
  try {
    return (JSON.parse(text) as { tokens?: { refresh_token?: unknown } }).tokens?.refresh_token === POOL_ID;
  } catch {
    return false;
  }
}

export function codexPoolAuthJson(clientKey: string): string {
  const token = codexPoolToken(clientKey);
  const auth = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: token, access_token: token, refresh_token: POOL_ID, account_id: null },
    last_refresh: LAST_REFRESH,
  };
  return `${JSON.stringify(auth, null, JSON_INDENT)}\n`;
}
