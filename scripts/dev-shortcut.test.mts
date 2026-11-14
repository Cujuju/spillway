import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { macLauncherScript } from './dev-shortcut.mts';

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
