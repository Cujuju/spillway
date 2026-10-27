/**
 * ChatGPT login Codex reads from auth.json for its account calls. The id token carries the routed
 * account's email, so usage views (T3 Code) don't list that account twice.
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

function poolJwt(clientKey: string, email: string): string {
  const claims = {
    iat: 0,
    exp: NEVER_EXPIRES_AT,
    email,
    // No chatgpt_account_id: Codex then skips workspace discovery and the proxy names the routed account.
    'https://api.openai.com/auth': { chatgpt_plan_type: POOL_PLAN, chatgpt_user_id: POOL_ID, user_id: POOL_ID },
    'https://api.openai.com/profile': { email, email_verified: true },
  };
  const signature = createHash('sha256').update(clientKey).digest('base64url');
  return `${segment(JWT_HEADER)}.${segment(claims)}.${signature}`;
}

/** The bearer token, a proxy client key. Derived from the client key alone, so it survives account switches and regenerating that key retires it. */
export function codexPoolToken(clientKey: string): string {
  return poolJwt(clientKey, POOL_EMAIL);
}

/** True for any pool login, whichever client key it came from. */
export function isCodexPoolAuth(text: string): boolean {
  try {
    return (JSON.parse(text) as { tokens?: { refresh_token?: unknown } }).tokens?.refresh_token === POOL_ID;
  } catch {
    return false;
  }
}

/** True for the pool login of this client key, whichever account it names. */
export function codexPoolAuthMatches(text: string, clientKey: string): boolean {
  try {
    const tokens = (JSON.parse(text) as { tokens?: { refresh_token?: unknown; access_token?: unknown } }).tokens;
    return tokens?.refresh_token === POOL_ID && tokens.access_token === codexPoolToken(clientKey);
  } catch {
    return false;
  }
}

/** `accountEmail` is the account Codex's account calls reach (null before the first usage poll). Codex reads identity from the id token only. */
export function codexPoolAuthJson(clientKey: string, accountEmail: string | null): string {
  const auth = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: poolJwt(clientKey, accountEmail ?? POOL_EMAIL),
      access_token: codexPoolToken(clientKey),
      refresh_token: POOL_ID,
      account_id: null,
    },
    last_refresh: LAST_REFRESH,
  };
  return `${JSON.stringify(auth, null, JSON_INDENT)}\n`;
}
