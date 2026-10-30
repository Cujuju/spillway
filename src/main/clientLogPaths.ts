import path from 'node:path';

export const isClientLogFile = (file: string): boolean => /\.jsonl(?:\.zst)?$/.test(file);

/** macOS permits case-sensitive volumes; only Windows keys fold case. Never use keys for filesystem access. */
export function clientLogKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(file);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
