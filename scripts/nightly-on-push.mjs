// Publishes this OS's nightly update after `main` reaches origin (README → Updates → Nightly on push).
//   node scripts/nightly-on-push.mjs spawn <sha>   (pre-push hook: starts the worker detached, returns at once)
//   node scripts/nightly-on-push.mjs run <sha>     (worker: waits for origin to reach <sha>, builds, publishes)
// Builds in a clean worktree so other sessions' uncommitted edits never ship. Log: <git dir>/spillway-nightly.log.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Sibling of the repo, so the `link:../solidjs-toolkit` packages and ../CLIProxyAPI resolve as in the main checkout. */
const WORKTREE = path.join(ROOT, '..', 'spillway-nightly');
const BRANCH = 'refs/heads/main';
/** The hook runs before the push is sent; how long the worker waits for it to land. */
const PUSH_WAIT_MS = 10 * 60_000;
const PUSH_POLL_MS = 5_000;

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
const LOG = path.join(gitDir, 'spillway-nightly.log');
/** One worker per machine; a push during a build is picked up when that build finishes. */
const LOCK = path.join(gitDir, 'spillway-nightly.lock');
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

/** A lock left by a killed worker must not block every later nightly. */
function locked() {
  try { process.kill(Number(readFileSync(LOCK, 'utf8')), 0); return true; } catch { rmSync(LOCK, { force: true }); return false; }
}

function spawnWorker(sha) {
  if (existsSync(LOCK) && locked()) return;
  const out = openSync(LOG, 'a');
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', sha], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, out] }).unref();
  closeSync(out);
}

const remoteHead = () => git(['ls-remote', 'origin', BRANCH]).split(/\s/)[0] ?? '';

async function waitForPush(sha) {
  for (const deadline = Date.now() + PUSH_WAIT_MS; Date.now() < deadline; await new Promise((r) => setTimeout(r, PUSH_POLL_MS))) {
    if (remoteHead() === sha) return sha;
  }
  return null;
}

function run(cmd, args, env = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  // Windows resolves pnpm through its .cmd shim, which needs a shell.
  execFileSync(cmd, args, { cwd: WORKTREE, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
}

function publish(sha) {
  git(['fetch', 'origin', BRANCH]);
  if (!existsSync(WORKTREE)) git(['worktree', 'add', '--detach', WORKTREE, sha]);
  git(['checkout', '--detach', '--force', sha], WORKTREE);
  git(['clean', '-fdx', '-e', 'node_modules'], WORKTREE);
  delete process.env.ELECTRON_RUN_AS_NODE;
  run('pnpm', ['install', '--frozen-lockfile']);
  run('pnpm', ['proxy:build']);
  run('pnpm', ['package']);
  // Update files only; full installers (macOS disk images) wait for a manual release.
  run('pnpm', ['release', 'nightly'], { SPILLWAY_UPDATE_ONLY: '1' });
}

async function worker(pushed) {
  try { writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); } catch { return; }
  try {
    let built = null;
    // The hook fires before the push lands, so the first round waits for origin to reach it.
    let sha = await waitForPush(pushed);
    while (sha && sha !== built) {
      log(`nightly for ${sha}`);
      try { publish(sha); log('published'); } catch (e) { log(`failed: ${e.message}`); }
      built = sha;
      sha = remoteHead();
    }
    if (!built) log('push did not reach origin; no nightly');
  } finally { rmSync(LOCK, { force: true }); }
}

const [mode, sha] = process.argv.slice(2);
if (!sha) { console.error('usage: spawn <sha> | run <sha>'); process.exit(1); }
if (mode === 'spawn') spawnWorker(sha);
else if (mode === 'run') await worker(sha);
