import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { removeLinks, removeWorktree } from './remove-worktree.mts';

// Junctions need no admin rights on Windows; other platforms use a directory symlink.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
// Each case runs several git commands, which are slow on a busy Windows machine.
const GIT_HEAVY_TIMEOUT_MS = 60_000;

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'remove-worktree-'));
  const repo = path.join(base, 'main');
  const outside = path.join(base, 'main-node_modules');
  const wt = path.join(base, 'wt');
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'keep.txt'), 'must survive\n');
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init', '--', 'a.txt');
  git('worktree', 'add', '-q', wt, '-b', 'feature');
  mkdirSync(path.join(wt, 'pkg'));
  symlinkSync(outside, path.join(wt, 'node_modules'), LINK_TYPE);
  symlinkSync(outside, path.join(wt, 'pkg', 'node_modules'), LINK_TYPE);
  return { base, repo, outside, wt, git };
}

it('removes the worktree and its branch, leaving every link target intact', () => {
  const f = fixture();
  try {
    const report = removeWorktree({ target: f.wt, repo: f.repo, deleteBranch: true, orphan: false });
    expect(report).toMatchObject({ removed: true, branch: 'feature' });
    expect(report.links).toHaveLength(2);
    expect(existsSync(f.wt)).toBe(false);
    expect(existsSync(path.join(f.outside, 'keep.txt'))).toBe(true);
    expect(f.git('branch', '--list', 'feature').trim()).toBe('');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
}, GIT_HEAVY_TIMEOUT_MS);

it('refuses the main checkout and anything that contains it', () => {
  const f = fixture();
  try {
    expect(() => removeWorktree({ target: f.repo, repo: f.repo, deleteBranch: false, orphan: true })).toThrow(/main checkout/);
    expect(() => removeWorktree({ target: f.base, repo: f.repo, deleteBranch: false, orphan: true })).toThrow(/main checkout/);
    expect(existsSync(path.join(f.repo, 'a.txt'))).toBe(true);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
}, GIT_HEAVY_TIMEOUT_MS);

// Git lists worktrees by real path; a temp folder is often reached through a link or a Windows short name.
it('matches the main checkout and a worktree reached through a link', () => {
  const f = fixture();
  const alias = `${f.base}-alias`;
  symlinkSync(f.base, alias, LINK_TYPE);
  try {
    expect(() => removeWorktree({ target: path.join(alias, 'main'), repo: f.repo, deleteBranch: false, orphan: true })).toThrow(/main checkout/);
    expect(removeWorktree({ target: path.join(alias, 'wt'), repo: f.repo, deleteBranch: false, orphan: false }).removed).toBe(true);
    expect(existsSync(path.join(f.repo, 'a.txt'))).toBe(true);
  } finally {
    // A junction needs rmdir on Windows; neither call follows the link.
    try { unlinkSync(alias); } catch { rmdirSync(alias); }
    rmSync(f.base, { recursive: true, force: true });
  }
}, GIT_HEAVY_TIMEOUT_MS);

it('an unregistered folder needs --orphan, and is then removed without following links', () => {
  const f = fixture();
  try {
    removeLinks(f.wt);
    f.git('worktree', 'remove', '--force', f.wt);
    mkdirSync(f.wt);
    symlinkSync(f.outside, path.join(f.wt, 'node_modules'), LINK_TYPE);
    expect(() => removeWorktree({ target: f.wt, repo: f.repo, deleteBranch: false, orphan: false })).toThrow(/--orphan/);
    expect(removeWorktree({ target: f.wt, repo: f.repo, deleteBranch: false, orphan: true }).removed).toBe(true);
    expect(existsSync(path.join(f.outside, 'keep.txt'))).toBe(true);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
}, GIT_HEAVY_TIMEOUT_MS);
