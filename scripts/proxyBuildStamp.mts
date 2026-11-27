// Lets `pnpm dev` skip the proxy build when nothing it compiles has changed since the last good build.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** build-proxy.mjs writes its output under the fork's dist/, so the fork's state leaves it out. */
const OUTPUT_DIR = 'dist';
const STAMP_FILE = 'build-stamp.json';

interface Stamp { key: string; size: number; mtimeMs: number }

function git(src: string, args: string[], input?: string): string {
  // A large uncommitted diff is still one state; no cap.
  return execFileSync('git', args, { cwd: src, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: Infinity });
}

/** The fork checkout by content: HEAD, every uncommitted change to tracked files, and every untracked file. */
export function sourceState(src: string): string {
  const scope = ['--', '.', `:(exclude)${OUTPUT_DIR}`];
  const hash = createHash('sha256');
  hash.update(git(src, ['rev-parse', 'HEAD']));
  hash.update(git(src, ['diff', 'HEAD', '--binary', ...scope]));
  const untracked = git(src, ['ls-files', '-z', '--others', '--exclude-standard', ...scope]).split('\0').filter(Boolean);
  if (untracked.length) {
    hash.update(untracked.join('\0'));
    // hash-object without -w reads the files and writes nothing to the repo.
    hash.update(git(src, ['hash-object', '--stdin-paths'], `${untracked.join('\n')}\n`));
  }
  return hash.digest('hex');
}

const stampPath = (binary: string) => path.join(path.dirname(binary), STAMP_FILE);

/** True when `binary` is the file the last good build with this key wrote. */
export function isUpToDate(binary: string, key: string): boolean {
  if (!existsSync(binary) || !existsSync(stampPath(binary))) return false;
  let stamp: Stamp;
  try { stamp = JSON.parse(readFileSync(stampPath(binary), 'utf8')) as Stamp; } catch { return false; }
  const { size, mtimeMs } = statSync(binary);
  return stamp.key === key && stamp.size === size && stamp.mtimeMs === mtimeMs;
}

/** Records `key` for the binary a build just wrote. electron-builder.ts ships only the binary from its folder. */
export function writeStamp(binary: string, key: string): void {
  const { size, mtimeMs } = statSync(binary);
  writeFileSync(stampPath(binary), JSON.stringify({ key, size, mtimeMs } satisfies Stamp));
}
