/**
 * Env vars that send Claude Code through the proxy. The client key rides in a custom header, not
 * ANTHROPIC_AUTH_TOKEN, so Claude Code keeps its subscription login and reports the proxy's usage-limit
 * resets (T3 Code snoozes threads from them). In token mode Claude Code ignores those headers.
 */
export const CLAUDE_BASE_URL_VAR = 'ANTHROPIC_BASE_URL';
export const CLAUDE_HEADERS_VAR = 'ANTHROPIC_CUSTOM_HEADERS';
/** Switches Claude Code to API-token mode; setup removes it. */
export const CLAUDE_TOKEN_VAR = 'ANTHROPIC_AUTH_TOKEN';
/** The proxy accepts its client key in this header alongside Claude Code's own Authorization. */
export const CLAUDE_KEY_HEADER = 'X-Api-Key';

export const claudeKeyHeader = (key: string) => `${CLAUDE_KEY_HEADER}: ${key}`;

/** The variables a client needs, in display order. */
export const claudeEnvVars = (endpoint: string, key: string) => [
  { name: CLAUDE_BASE_URL_VAR, value: endpoint },
  { name: CLAUDE_HEADERS_VAR, value: claudeKeyHeader(key) },
];
