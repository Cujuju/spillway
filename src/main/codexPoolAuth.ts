/**
 * The pool login earlier versions wrote to Codex's auth.json. Codex now keeps its own ChatGPT login,
 * which the proxy verifies; apply and undo retire this one.
 */
const POOL_ID = 'spillway-pool';

export const CODEX_AUTH_FILE = 'auth.json';

/** True for any pool login, whichever client key it came from. */
export function isCodexPoolAuth(text: string): boolean {
  try {
    return (JSON.parse(text) as { tokens?: { refresh_token?: unknown } }).tokens?.refresh_token === POOL_ID;
  } catch {
    return false;
  }
}
