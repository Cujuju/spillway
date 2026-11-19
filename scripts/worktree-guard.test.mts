import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'hooks', 'guard.mjs');
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const BLOCK = true;
const ALLOW = false;

// A main checkout (.git folder), a worktree (.git file), and folders whose node_modules are links.
const T = mkdtempSync(path.join(tmpdir(), 'worktree-guard-'));
const MAIN = path.join(T, 'main');
const WT = path.join(T, 'wt');
const LINKED = path.join(T, 'linked');
const CHILD = path.join(T, 'child');
const OTHER = path.join(T, 'norepo');
for (const d of [path.join(MAIN, '.git', 'worktrees', 'wt'), path.join(MAIN, 'node_modules'), path.join(WT, 'node_modules'), LINKED, path.join(CHILD, 'pkg'), OTHER, path.join(T, 'target')]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(path.join(WT, '.git'), `gitdir: ${path.join(MAIN, '.git', 'worktrees', 'wt')}\n`);
symlinkSync(path.join(T, 'target'), path.join(LINKED, 'node_modules'), LINK_TYPE);
symlinkSync(path.join(T, 'target'), path.join(CHILD, 'pkg', 'node_modules'), LINK_TYPE);
const MAIN_ELECTRON = path.join(MAIN, 'node_modules', 'electron', 'dist', 'electron.exe');
const WT_ELECTRON = path.join(WT, 'node_modules', 'electron', 'dist', 'electron.exe');

afterAll(() => {
  rmSync(path.join(LINKED, 'node_modules'));
  rmSync(path.join(CHILD, 'pkg', 'node_modules'));
  rmSync(T, { recursive: true, force: true });
});

const CASES: [boolean, string, string, string, string?][] = [
  [BLOCK, 'junction node_modules (PowerShell)', 'New-Item -ItemType Junction -Path "E:/wt/node_modules" -Target "E:/main/node_modules"', OTHER],
  [BLOCK, 'junction node_modules (mklink)', 'cmd /c mklink /J "E:/wt/node_modules" "E:/main/node_modules"', OTHER],
  [BLOCK, 'symlink node_modules (ln -s)', 'ln -s ../main/node_modules node_modules', OTHER],
  [ALLOW, 'a plain node_modules folder', 'New-Item -ItemType Directory node_modules', OTHER],
  [BLOCK, 'pnpm install over a linked node_modules', 'pnpm install --frozen-lockfile', LINKED],
  [BLOCK, 'pnpm from a root whose child package is linked', 'pnpm exec tsc', CHILD],
  [BLOCK, 'pnpm reached through an absolute cd', `cd "${LINKED}" && pnpm install`, OTHER],
  [ALLOW, 'pnpm install over a real node_modules', 'pnpm install --frozen-lockfile', WT],
  [ALLOW, 'pnpm only inside a string', 'echo "pnpm install"', LINKED],
  [BLOCK, 'purge flag in the main checkout', 'pnpm install --config.confirmModulesPurge=false', MAIN],
  [BLOCK, 'recursive delete of main node_modules', 'Remove-Item -Recurse -Force node_modules', MAIN],
  [ALLOW, 'deleting node_modules in a worktree', 'rm -rf node_modules', WT],
  [ALLOW, 'a heredoc body naming the purge flag', "cat > pr.md <<'EOF'\nblocks `confirmModulesPurge`\nrm -rf node_modules\nEOF\ngh pr create --body-file pr.md", MAIN],
  [BLOCK, 'a heredoc fed to a shell is code', "bash <<'EOF'\nrm -rf node_modules\nEOF", MAIN],
  [BLOCK, 'a real command after a heredoc', "cat > x <<'EOF'\nnotes\nEOF\nrm -rf node_modules", MAIN],
  [BLOCK, 'install while Electron runs from the main checkout', 'pnpm install', MAIN, MAIN_ELECTRON],
  [ALLOW, 'install with the app closed', 'pnpm install', MAIN],
  [ALLOW, 'install while only a worktree runs Electron', 'pnpm install', MAIN, WT_ELECTRON],
  [ALLOW, 'builds while the app runs', 'pnpm run build', MAIN, MAIN_ELECTRON],
  [BLOCK, 'git worktree remove', 'git worktree remove --force E:/x', MAIN],
  [ALLOW, 'a commit message naming the old command', 'git commit -m "docs: replace git worktree remove" -- CLAUDE.md', MAIN],
];

it.each(CASES)('%s: %s', (expected, _label, command, cwd, processPaths = '') => {
  const r = spawnSync('node', [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8', env: { ...process.env, GUARD_PROCESS_PATHS: processPaths },
  });
  expect(r.status === 2).toBe(expected);
});

it('lets non-shell tools through', () => {
  const r = spawnSync('node', [GUARD], { input: JSON.stringify({ tool_name: 'Edit', tool_input: {} }), encoding: 'utf8' });
  expect(r.status).toBe(0);
});
