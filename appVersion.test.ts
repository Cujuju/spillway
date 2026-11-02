import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appVersion, gitBuild } from './appVersion.ts';
import { MODIFIED_SUFFIX } from './src/shared/buildInfo.ts';

let root: string;
let repo: string;
let isolatedEnv: NodeJS.ProcessEnv;
// An empty global config and no system config: the user's hooks and settings would otherwise run on every commit.
const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8', env: isolatedEnv });
const commit = (subject: string): string => git('commit', '-q', '--allow-empty', '-m', subject);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spillway-version-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(globalConfig, '');
  isolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  git('init', '-q', '-b', 'main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('appVersion', () => {
  it('computes a release commit version without changing the checkout', () => {
    commit('feat: base');
    const released = git('rev-parse', 'HEAD').trim();
    commit('fix: next');
    expect(appVersion(repo, released)).toBe('0.1.0');
    expect(appVersion(repo)).toBe('0.1.1');
  });
  it('bumps patch for non-feature commits', () => {
    commit('fix: a');
    commit('docs: b');
    expect(appVersion(repo)).toBe('0.0.2');
  });

  it('bumps minor for a feature and resets patch', () => {
    commit('fix: a');
    commit('feat: b');
    expect(appVersion(repo)).toBe('0.1.0');
    commit('style(ui): c');
    expect(appVersion(repo)).toBe('0.1.1');
  });

  it('counts scoped and breaking features', () => {
    commit('feat(ui): a');
    commit('feat!: b');
    commit('feature: not conventional');
    expect(appVersion(repo)).toBe('0.2.1');
  });

  it('keeps rising across a merge of patches, and ignores the merge commit', () => {
    commit('feat: base');
    git('checkout', '-q', '-b', 'side');
    commit('fix: side');
    git('checkout', '-q', 'main');
    commit('fix: main');
    expect(appVersion(repo)).toBe('0.1.1');
    git('merge', '-q', '--no-ff', '--no-edit', 'side');
    expect(appVersion(repo)).toBe('0.1.2');
  });

  it('refuses a checkout without commits', () => {
    expect(() => appVersion(repo)).toThrow(/git history/);
  });
});

describe('gitBuild', () => {
  it('is the short hash, marked modified while the tree has uncommitted files', () => {
    commit('fix: a');
    const hash = git('rev-parse', '--short', 'HEAD').trim();
    expect(gitBuild(repo)).toBe(hash);
    writeFileSync(join(repo, 'new.txt'), 'x');
    expect(gitBuild(repo)).toBe(`${hash}${MODIFIED_SUFFIX}`);
  });
});
