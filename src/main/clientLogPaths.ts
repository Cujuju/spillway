import path from 'node:path';

export type ClientLogProvider = 'claude' | 'codex' | 'antigravity';

const ANY_LOG_FILE = /\.jsonl(?:\.zst)?$/;
/** Antigravity duplicates turns into transcript_full.jsonl and chunks/*.jsonl; only transcript.jsonl is canonical. */
const ANTIGRAVITY_LOG_FILE = /(?:^|[\\/])transcript\.jsonl(?:\.zst)?$/;

export const isClientLogFile = (file: string, provider?: ClientLogProvider): boolean =>
  provider === 'antigravity' ? ANTIGRAVITY_LOG_FILE.test(file) : ANY_LOG_FILE.test(file);

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

/** macOS permits case-sensitive volumes; only Windows keys fold case. Never use keys for filesystem access. */
export function clientLogKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(file);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
