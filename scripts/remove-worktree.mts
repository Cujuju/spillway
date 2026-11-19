// Removes a git worktree without ever deleting through a link.
// Usage: node scripts/remove-worktree.mts <path> [--delete-branch] [--orphan] [--repo <main checkout>]
// --orphan: a leftover folder git no longer tracks.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Delete retries ride out brief antivirus or indexer handles, not a running process.
const DELETE_RETRIES = 5;
const DELETE_RETRY_DELAY_MS = 200;
const LOCK_SCAN_TIMEOUT_MS = 60_000;
// Processes that load native addons (.node) from a checkout; reading every process's modules takes about a minute.
const MODULE_HOSTS = ['node', 'electron', 'esbuild'];

export interface RemoveOptions { target: string; repo: string; deleteBranch: boolean; orphan: boolean }
export interface RemoveReport { target: string; links: string[]; lockers: string[]; removed: boolean; branch: string | null }
interface Worktree { path: string; branch?: string }

/** The path with links and Windows short names resolved, as git reports worktrees; a missing tail keeps its name. */
function realPath(p: string): string {
  const abs = path.resolve(p);
  try { return realpathSync.native(abs); } catch { /* missing: resolve what exists */ }
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
}
const canon = (p: string): string => realPath(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const contains = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

function git(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', ['-c', 'core.longpaths=true', '-C', repo, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function parseArgs(argv: string[]): RemoveOptions {
  let target: string | null = null;
  const opts = { deleteBranch: false, orphan: false, repo: DEFAULT_REPO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--delete-branch') opts.deleteBranch = true;
    else if (a === '--orphan') opts.orphan = true;
    else if (a === '--repo') opts.repo = argv[++i] ?? opts.repo;
    else if (target === null) target = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (target === null) throw new Error('usage: node scripts/remove-worktree.mts <path> [--delete-branch] [--orphan] [--repo <main checkout>]');
  return { target, ...opts };
}

function listWorktrees(repo: string): Worktree[] {
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) throw new Error(`git worktree list failed: ${r.err}`);
  const entries: Worktree[] = [];
  for (const block of r.out.split(/\n\n+/)) {
    let wtPath: string | undefined;
    let branch: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
    }
    if (wtPath) entries.push(branch ? { path: wtPath, branch } : { path: wtPath });
  }
  return entries;
}

/** Unlinks every symlink and junction under root without following any. Returns the links removed. */
export function removeLinks(root: string): string[] {
  const removed: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) {
        // A directory junction or symlink on Windows needs rmdir; unlink handles the rest.
        try { unlinkSync(full); } catch { rmdirSync(full); }
        removed.push(full);
      } else if (st.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return removed;
}

/** Processes running a binary, or holding a loaded module, from inside root (Windows only). */
function lockingProcesses(root: string): string[] {
  if (process.platform !== 'win32') return [];
  const prefix = path.resolve(root).toLowerCase().replace(/'/g, "''");
  const script = `
$root = '${prefix}'
Get-Process | ForEach-Object {
  $p = $_
  try {
    $files = @($p.Path)
    if ('${MODULE_HOSTS.join("','")}' -split "','" -contains $p.ProcessName) { $files += @($p.Modules | ForEach-Object FileName) }
    $hit = $files | Where-Object { $_ -and $_.ToLower().StartsWith($root) } | Select-Object -First 1
    if ($hit) { "$($p.Id) $($p.ProcessName) $hit" }
  } catch {}
}`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: LOCK_SCAN_TIMEOUT_MS });
  return (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function removeWorktree(opts: RemoveOptions): RemoveReport {
  const repo = path.resolve(opts.repo);
  const target = path.resolve(opts.target);
  const worktrees = listWorktrees(repo);
  const main = worktrees[0];
  if (!main) throw new Error(`no worktrees listed for ${repo}`);
  if (contains(canon(target), canon(main.path)) || contains(canon(main.path), canon(target))) {
    throw new Error(`refusing: ${target} is or overlaps the main checkout ${main.path}`);
  }
  const entry = worktrees.slice(1).find((w) => canon(w.path) === canon(target));
  if (!entry && !opts.orphan) throw new Error(`${target} is not a registered worktree of ${repo}; pass --orphan for a leftover folder`);
  if (entry && opts.orphan) throw new Error(`${target} is still registered; drop --orphan`);

  const report: RemoveReport = { target, links: [], lockers: [], removed: false, branch: null };
  if (existsSync(target)) {
    report.links = removeLinks(target);
    if (entry) git(repo, ['worktree', 'remove', '--force', target]);
    if (existsSync(target)) {
      try { rmSync(target, { recursive: true, force: true, maxRetries: DELETE_RETRIES, retryDelay: DELETE_RETRY_DELAY_MS }); } catch { /* reported below */ }
    }
    // Scanned only on failure: the scan is slow and the worktree is being discarded anyway.
    if (existsSync(target)) report.lockers = lockingProcesses(target);
  }
  git(repo, ['worktree', 'prune']);
  report.removed = !existsSync(target);
  if (report.removed && opts.deleteBranch && entry?.branch) {
    const r = git(repo, ['branch', '-D', entry.branch]);
    report.branch = r.ok ? entry.branch : `not deleted: ${r.err}`;
  }
  return report;
}

if (process.argv[1] && canon(process.argv[1]) === canon(fileURLToPath(import.meta.url))) {
  try {
    const report = removeWorktree(parseArgs(process.argv.slice(2)));
    console.log(`links unlinked (targets untouched): ${report.links.length}`);
    if (!report.removed) {
      console.error(`Not fully deleted: ${report.target} still exists. Rerun with --orphan once these are closed:`);
      for (const l of report.lockers) console.error(`  ${l}`);
      if (report.lockers.length === 0) console.error('  (no process found; an open file handle or a reboot-pending delete)');
      process.exit(1);
    }
    console.log(`removed ${report.target}${report.branch ? `; branch ${report.branch}` : ''}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
