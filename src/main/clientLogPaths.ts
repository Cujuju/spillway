import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type ClientLogProvider = 'claude' | 'codex' | 'antigravity';

const ANY_LOG_FILE = /\.jsonl(?:\.zst)?$/;
/** Antigravity duplicates turns into transcript_full.jsonl and chunks/*.jsonl; only transcript.jsonl is canonical. */
const ANTIGRAVITY_LOG_FILE = /(?:^|[\\/])transcript\.jsonl(?:\.zst)?$/;

export const isClientLogFile = (file: string, provider?: ClientLogProvider): boolean =>
  provider === 'antigravity' ? ANTIGRAVITY_LOG_FILE.test(file) : ANY_LOG_FILE.test(file);

export function shouldSkipClientLogPath(file: string, provider: ClientLogProvider): boolean {
  if (provider !== 'antigravity') return false;
  const segments = path.posix.normalize(file.replaceAll('\\', '/')).toLowerCase().split('/');
  return segments.some((name, index) => {
    const parent = segments[index - 1];
    return (parent === '.system_generated' && ['steps', 'messages', 'tasks', 'undelivered'].includes(name))
      || (parent === 'logs' && (name === 'chunks' || name === 'media'))
      || (segments[index - 2] === 'brain' && (name === 'scratch' || name === '.user_uploaded'));
  });
}

/** Resolves T3 Code's userdata root from env or default ~/.t3/userdata. */
export function t3UserdataDir(): string {
  return process.env.T3_USERDATA_DIR || path.join(process.env.T3CODE_HOME || path.join(homedir(), '.t3'), 'userdata');
}

/** Derives conversation session and client variant from Antigravity's `.../brain/<id>/...` path. */
export function antigravityLogContext(file: string): { session?: string; client: string } {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  const brainIndex = parts.lastIndexOf('brain');
  const session = brainIndex >= 0 && brainIndex + 1 < parts.length ? parts[brainIndex + 1] : undefined;
  const client = parts.includes('antigravity-acp') ? 'antigravity-acp'
    : parts.includes('antigravity-cli') ? 'antigravity-cli'
    : 'antigravity';
  return { ...(session ? { session } : {}), client };
}

/** Returns the parent directory of `brain` for an Antigravity transcript path, or null. */
function antigravityBrainParent(file: string): string | null {
  let current = path.dirname(file);
  while (true) {
    const parent = path.dirname(current);
    if (path.basename(current).toLowerCase() === 'brain' && parent !== current) return parent;
    if (parent === current) return null;
    current = parent;
  }
}

/** Returns `<parent-of-brain>/antigravity-oauth-token` for an Antigravity transcript path, or null. */
export function antigravityOAuthTokenPath(file: string): string | null {
  const parent = antigravityBrainParent(file);
  return parent ? path.join(parent, 'antigravity-oauth-token') : null;
}

/** Returns `<parent-of-brain>/conversation_summaries.db` for an Antigravity transcript path, or null. */
export function antigravitySummaryDbPath(file: string): string | null {
  const parent = antigravityBrainParent(file);
  return parent ? path.join(parent, 'conversation_summaries.db') : null;
}

/** Existing Antigravity conversation summary SQLite databases across T3 ACP, CLI, and IDE roots. */
export function antigravitySummaryDbs(): string[] {
  const geminiHome = process.env.GEMINI_HOME || path.join(homedir(), '.gemini');
  const dbs: string[] = [];
  const pushIfExists = (file: string) => { if (existsSync(file)) dbs.push(file); };
  pushIfExists(path.join(geminiHome, 'antigravity-cli', 'conversation_summaries.db'));
  pushIfExists(path.join(geminiHome, 'antigravity', 'conversation_summaries.db'));
  const t3Providers = path.join(t3UserdataDir(), 'providers', 'antigravity');
  if (existsSync(t3Providers)) {
    try {
      for (const entry of readdirSync(t3Providers, { withFileTypes: true })) {
        if (entry.isDirectory()) pushIfExists(path.join(t3Providers, entry.name, 'antigravity-acp', 'conversation_summaries.db'));
      }
    } catch { /* Directory unreadable: titles remain optional. */ }
  }
  return dbs;
}

/** macOS permits case-sensitive volumes; only Windows keys fold case. Never use keys for filesystem access. */
export function clientLogKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(file);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
