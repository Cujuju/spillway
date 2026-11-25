import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { macLauncherScript, WINDOWS_TASK_NAME } from './dev-shortcut.mts';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEV_LAUNCH_PS1 = path.join(SCRIPTS_DIR, 'dev-launch.ps1');
const DEV_SHORTCUT_PS1 = path.join(SCRIPTS_DIR, 'dev-shortcut.ps1');

// The launcher runs under zsh; its quoting is POSIX, so any POSIX shell checks the assignment.
const SHELLS: Partial<Record<NodeJS.Platform, string>> = { darwin: '/bin/zsh', linux: '/bin/sh', win32: String.raw`C:\Program Files\Git\bin\sh.exe` };
const shell = SHELLS[process.platform];
const ROOTS = ["/Users/jo's/projects/spillway", '/Users/a b/spillway', '/tmp/$HOME/`id`/$(id)', String.raw`/tmp/back\slash/"quoted"`];

it.runIf(shell && existsSync(shell))('assigns repo paths with quotes, spaces, $ and backticks verbatim', () => {
  for (const root of ROOTS) {
    const assignment = macLauncherScript(root).split('\n').find((line) => line.startsWith('repo='));
    const out = spawnSync(shell!, ['-c', `${assignment}\nprintf '%s' "$repo"`], { encoding: 'utf8' });
    expect({ root, status: out.status, stderr: out.stderr }).toEqual({ root, status: 0, stderr: '' });
    expect(out.stdout).toBe(root);
  }
});

it.runIf(process.platform === 'darwin')('generates a launcher zsh parses', () => {
  for (const root of ROOTS) expect(spawnSync('/bin/zsh', ['-n'], { input: macLauncherScript(root) }).status).toBe(0);
});

it('sets a default dev CDP port in the launcher script', () => {
  expect(macLauncherScript('/tmp/spillway')).toContain('export REMOTE_DEBUGGING_PORT="${REMOTE_DEBUGGING_PORT:-9333}"');
});

it('guards Windows dev-launch against non-Default desktops and registers a matching interactive task', () => {
  const launchScript = readFileSync(DEV_LAUNCH_PS1, 'utf8');
  const shortcutScript = readFileSync(DEV_SHORTCUT_PS1, 'utf8');
  const shortcutMts = readFileSync(path.join(SCRIPTS_DIR, 'dev-shortcut.mts'), 'utf8');
  expect(shortcutMts).toContain(`WINDOWS_TASK_NAME = '${WINDOWS_TASK_NAME}'`);
  expect(launchScript).toContain('GetUserObjectInformationW');
  expect(launchScript).toContain("$interactiveDesktop = 'Default'");
  expect(launchScript).toContain('Start-ScheduledTask -TaskName $TaskName');
  expect(launchScript).toContain('Show-RunningApp');
  expect(shortcutScript).toContain('-LogonType Interactive');
  expect(shortcutScript).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)');
  expect(shortcutScript).toContain('-MultipleInstances Parallel');
});

it.runIf(process.platform === 'win32')('parses Windows launcher and shortcut scripts cleanly in Windows PowerShell', () => {
  const check = [DEV_LAUNCH_PS1, DEV_SHORTCUT_PS1]
    .map((file) => {
      const escaped = file.replaceAll("'", "''");
      return `$e = $null; [void][Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`;
    })
    .join('; ');
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', check], { encoding: 'utf8' });
  expect({ status: out.status, stderr: out.stderr }).toEqual({ status: 0, stderr: '' });
});
