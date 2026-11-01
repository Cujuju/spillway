// Scheduled nightly, every 6 hours per machine (docs/releasing.md → Scheduled nightly).
// Usage: node scripts/nightly.mts run [--log] | install | uninstall
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPDATE_REPO } from '../src/shared/updateFeed.ts';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
/** Clean worktrees of all three repos side by side, so `link:../solidjs-toolkit` and ../CLIProxyAPI resolve to them. */
const NIGHTLY = path.join(ROOT, '..', '.spillway-nightly');
const WORKTREE = path.join(NIGHTLY, 'spillway');
/** Built from their latest pushed default branch, never from the shared sibling checkouts. */
const SIBLINGS = ['solidjs-toolkit', 'CLIProxyAPI'];
const INTERVAL_HOURS = 6;
const SECONDS_PER_HOUR = 3600;
const TASK_NAME = 'Spillway nightly';
const LAUNCH_LABEL = 'com.cujuju.spillway.nightly';
const LAUNCH_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);
/** The macOS app ships both architectures, so the Mac builds both proxies. */
const PROXY_TARGETS: Partial<Record<NodeJS.Platform, string[]>> = { darwin: ['darwin-arm64', 'darwin-x64'] };

const git = (args: string[], cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gh = (args: string[]) => execFileSync('gh', [...args, '--repo', UPDATE_REPO], { encoding: 'utf8' }).trim();
const gitDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
const LOG = path.join(gitDir, 'spillway-nightly.log');
/** One run per machine; a run that outlasts the interval makes the next one skip. */
const LOCK = path.join(gitDir, 'spillway-nightly.lock');
/** Schedulers have no console worth keeping, so scheduled runs write to the log file. */
const out = process.argv.includes('--log') ? openSync(LOG, 'a') : 1;
const log = (message: string) => void writeSync(out, `${new Date().toISOString()} ${message}
`);

/** A lock left by a killed run must not block every later nightly. */
function lockHeld(): boolean {
  if (!existsSync(LOCK)) return false;
  try { process.kill(Number(readFileSync(LOCK, 'utf8')), 0); return true; } catch { rmSync(LOCK, { force: true }); return false; }
}

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, cwd = WORKTREE): void {
  log(`$ ${cmd} ${args.join(' ')} (${path.basename(cwd)})`);
  // Windows resolves pnpm through its .cmd shim, which needs a shell; the arguments are fixed literals.
  execFileSync([cmd, ...args].join(' '), { cwd, stdio: ['ignore', out, out], shell: true, env: { ...process.env, ...env } });
}

/** The commit to publish for this OS, or null when the newest release already has it and main has not moved. */
function target(): string | null {
  git(['fetch', '--tags', 'origin', 'main']);
  const [newest] = JSON.parse(gh(['release', 'list', '--limit', '1', '--json', 'tagName,isPrerelease'])) as { tagName: string; isPrerelease: boolean }[];
  const released = newest ? git(['rev-list', '-n', '1', newest.tagName]) : null;
  if (newest?.isPrerelease) {
    const assets = (JSON.parse(gh(['release', 'view', newest.tagName, '--json', 'assets'])) as { assets: { name: string }[] }).assets;
    if (!assets.some((a) => a.name === `update-${process.platform}.json`)) return released;
  }
  const main = git(['rev-parse', 'origin/main']);
  return main === released ? null : main;
}

/** Resets a worktree of `repo` at `dir` to `ref`, creating it on first use. */
function checkout(repo: string, dir: string, ref: string): void {
  if (!existsSync(dir)) git(['worktree', 'add', '--detach', dir, ref], repo);
  git(['checkout', '--detach', '--force', ref], dir);
  git(['clean', '-fdx', '-e', 'node_modules'], dir);
}

function publish(sha: string): void {
  for (const name of SIBLINGS) {
    const repo = path.join(ROOT, '..', name);
    git(['fetch', 'origin'], repo);
    checkout(repo, path.join(NIGHTLY, name), git(['rev-parse', 'origin/HEAD'], repo));
  }
  checkout(ROOT, WORKTREE, sha);
  delete process.env.ELECTRON_RUN_AS_NODE;
  sh('pnpm', ['install', '--frozen-lockfile'], {}, path.join(NIGHTLY, 'solidjs-toolkit'));
  sh('pnpm', ['install', '--frozen-lockfile']);
  // The release CLI and types come from the toolkit's gitignored dist/.
  sh('node', ['scripts/build-linked.mjs']);
  sh('pnpm', ['proxy:build', ...(PROXY_TARGETS[process.platform] ?? [])]);
  sh('pnpm', ['package']);
  // Update files only; full installers (macOS disk images) wait for a manual release.
  sh('pnpm', ['release', 'nightly'], { SPILLWAY_UPDATE_ONLY: '1' });
}

function run(): void {
  if (lockHeld()) return log('previous run still active; skipped');
  writeFileSync(LOCK, String(process.pid));
  try {
    const sha = target();
    if (!sha) return log('up to date');
    log(`nightly for ${sha}`);
    publish(sha);
    log('published');
  } catch (e) {
    log(`failed: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally { rmSync(LOCK, { force: true }); }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function install(): void {
  if (process.platform === 'win32') {
    // Hidden console via conhost; runs at the next interval after a missed one (sleep, shutdown).
    const ps = `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless "${process.execPath}" "${SCRIPT}" run --log' -WorkingDirectory '${ROOT}'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours ${INTERVAL_HOURS})
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -Force | Out-Null`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  } else if (process.platform === 'darwin') {
    const args = [process.execPath, SCRIPT, 'run', '--log'].map((a) => `<string>${xml(a)}</string>`).join('');
    mkdirSync(path.dirname(LAUNCH_PLIST), { recursive: true });
    // launchd starts with a minimal PATH; keep the one that finds pnpm, go, gh and git now.
    writeFileSync(LAUNCH_PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCH_LABEL}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xml(ROOT)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '')}</string></dict>
<key>StartInterval</key><integer>${INTERVAL_HOURS * SECONDS_PER_HOUR}</integer>
<key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict></plist>
`);
    const domain = `gui/${process.getuid!()}`;
    try { execFileSync('launchctl', ['bootout', domain, LAUNCH_PLIST], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
    execFileSync('launchctl', ['bootstrap', domain, LAUNCH_PLIST], { stdio: 'inherit' });
  } else throw new Error(`no scheduler for ${process.platform}`);
  log(`installed: every ${INTERVAL_HOURS} hours; log ${LOG}`);
}

function uninstall(): void {
  if (process.platform === 'win32') execFileSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'inherit' });
  else if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}`, LAUNCH_PLIST], { stdio: 'ignore' }); } catch { /* not loaded */ }
    rmSync(LAUNCH_PLIST, { force: true });
  }
}

const command = process.argv[2];
if (command === 'run') run();
else if (command === 'install') install();
else if (command === 'uninstall') uninstall();
else { console.error('usage: run | install | uninstall'); process.exitCode = 1; }
