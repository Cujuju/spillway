/**
 * `node scripts/packagedCheck.mts <Spillway.app> [--rosetta]`: launches a packaged macOS app on a throwaway profile and
 * checks its window, encrypted SQLite, bundled proxy and clean quit.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Cdp, freePort, sleep, until } from './demo/cdp.mts';

const QUIT_TIMEOUT_MS = 30_000;
// Cleanup retries ride out writes still landing from processes that are exiting.
const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_DELAY_MS = 200;
const SQLITE_PLAIN_HEADER ='SQLite format 3\0';
// Rosetta translates each x64 binary on first launch: CI runners took 37s to over 60s before DevTools answered.
const ROSETTA_READY_TIMEOUT_MS = 180_000;

const [bundle, ...flags] = process.argv.slice(2);
if (!bundle || process.platform !== 'darwin') {
  console.error('usage (macOS): node scripts/packagedCheck.mts <Spillway.app> [--rosetta]');
  process.exit(2);
}
const rosetta = flags.includes('--rosetta');
const app = path.resolve(bundle);
const exe = path.join(app, 'Contents', 'MacOS', 'Spillway');
const bundledProxy = path.join(app, 'Contents', 'Resources', 'bin', 'cli-proxy-api');

/** `vmmap`'s code type: ARM64E, X86-64, or X86-64 (translated) under Rosetta. */
const codeType = (pid: number) => /Code Type:\s*(.+)/.exec(execFileSync('vmmap', ['--summary', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))?.[1]?.trim() ?? 'unknown';

const scratch = mkdtempSync(path.join(tmpdir(), 'spillway-packaged-'));
const home = path.join(scratch, 'home');
const profile = path.join(scratch, 'profile');
mkdirSync(path.join(home, 'Library', 'Application Support'), { recursive: true });
mkdirSync(profile, { recursive: true });
const proxyPort = await freePort();
const debugPort = await freePort();
// Nothing that reaches past the profile: no login item, tray icons or update checks; its own proxy port.
writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  general: { launchAtLogin: false, confirmQuit: false, closeToTray: false },
  proxy: { autoStart: true, port: proxyPort },
  trayIcons: { enabled: false },
  updates: { autoCheck: false },
}));

const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
for (const name of ['ELECTRON_RUN_AS_NODE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete env[name];
// The throwaway home has no login keychain; Chromium's mock keychain stands in for it.
const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--use-mock-keychain'];
const child = rosetta ? spawn('/usr/bin/arch', ['-x86_64', exe, ...args], { env, stdio: 'inherit' }) : spawn(exe, args, { env, stdio: 'inherit' });
const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
const gone = () => (child.exitCode === null && child.signalCode === null ? null : `the app exited (${child.exitCode ?? child.signalCode})`);

// Undefined keeps the native startup budget.
const readyTimeoutMs = rosetta ? ROSETTA_READY_TIMEOUT_MS : undefined;

try {
  const cdp = await Cdp.mainWindow(debugPort, gone, readyTimeoutMs);
  await until('the page navigation', () => cdp.eval<number>(`document.querySelectorAll('button.nav-btn').length`).then((n) => n || null), gone, readyTimeoutMs);
  const days = await until('the activity database', () => cdp.eval<unknown[]>('window.api.activityDaySummaries("all")'), gone, readyTimeoutMs);
  const db = path.join(profile, 'activity.db');
  if (!existsSync(db)) throw new Error('activity.db was not created');
  const header = Buffer.alloc(16);
  const fd = openSync(db, 'r');
  readSync(fd, header, 0, 16, 0);
  closeSync(fd);
  if (header.toString('latin1') === SQLITE_PLAIN_HEADER) throw new Error('activity.db is not encrypted');
  const status = await until('the bundled proxy', () => cdp.eval<{ state: string; pid: number | null; executablePath: string | null; build: unknown }>('window.api.proxyStatus()')
    .then((s) => (s.state === 'running' ? s : null)), gone, readyTimeoutMs);
  if (status.executablePath !== bundledProxy) throw new Error(`proxy ran from ${status.executablePath}, not the bundle`);
  const reply = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
  cdp.close();
  // Under arch(1) the child is the app itself: arch execs it.
  console.log(`packaged: app pid ${child.pid} ${codeType(child.pid!)}; proxy pid ${status.pid} ${codeType(status.pid!)}`);
  console.log(`packaged: window ok; encrypted activity.db opened (${days.length} days); bundled proxy running, HTTP ${reply.status} on port ${proxyPort}`);

  child.kill('SIGTERM');
  const quit = await Promise.race([exited.then(() => true), sleep(QUIT_TIMEOUT_MS).then(() => false)]);
  if (!quit) throw new Error(`the app did not quit within ${QUIT_TIMEOUT_MS / 1000}s`);
  let proxyAlive = true;
  try { process.kill(status.pid!, 0); } catch { proxyAlive = false; }
  if (proxyAlive) throw new Error(`the proxy (pid ${status.pid}) outlived the app`);
  console.log(`packaged: ok, ${path.basename(path.dirname(app))}${rosetta ? ' under Rosetta' : ''} quit and stopped its proxy`);
} catch (err) {
  if (child.exitCode === null) child.kill('SIGKILL');
  throw err;
} finally {
  await Promise.race([exited, sleep(5_000)]);
  // A killed app's helpers and proxy may still be writing; a leftover temp folder must not replace the real failure.
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES, retryDelay: CLEANUP_RETRY_DELAY_MS }); } catch (err) {
    console.warn(`packaged: left ${scratch} behind: ${err instanceof Error ? err.message : String(err)}`);
  }
}
