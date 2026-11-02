import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertReleaseSiblings, ensureNightlyRelease, installerFiles, nightlyTarget, RELEASE_ARCHS, releaseDetails, type ReleaseView } from './releaseShared.mts';

vi.mock('node:child_process', { spy: true });
const GIT_TEST_TIMEOUT_MS = 30_000;
afterEach(() => { vi.mocked(execFileSync).mockReset(); vi.restoreAllMocks(); });
const complete: ReleaseView = { tagName: 'v0.1.0', isPrerelease: true,
  assets: Object.keys(RELEASE_ARCHS).map((p) => ({ name: `update-${p}.json` })) };

describe('nightly selection', () => {
  it('skips unchanged main and builds a new main commit', () => {
    expect(nightlyTarget('old', 'old', complete, false)).toBeNull();
    expect(nightlyTarget('new', 'old', complete, false)).toEqual({ sha: 'new', platforms: ['win32', 'darwin', 'linux'] });
  });
  it('retries missing platforms while main matches the prerelease source', () => {
    expect(nightlyTarget('old', 'old', { ...complete, assets: [{ name: 'update-darwin.json' }] }, false)).toEqual({ sha: 'old', platforms: ['win32', 'linux'] });
  });
  it.each([{ assets: [] }, { assets: [{ name: 'update-darwin.json' }] }])('builds advanced main for every platform despite an incomplete prerelease ($assets)', ({ assets }) => {
    expect(nightlyTarget('new', 'old', { ...complete, assets }, false)).toEqual({ sha: 'new', platforms: ['win32', 'darwin', 'linux'] });
  });
  it('starts from main without a release and allows manual unchanged builds', () => {
    expect(nightlyTarget('main', null, null, false)?.sha).toBe('main');
    expect(nightlyTarget('old', 'old', complete, true)?.sha).toBe('old');
    expect(nightlyTarget('new', 'old', { ...complete, assets: [] }, true)?.sha).toBe('new');
  });
  it('does not complete a stable release with nightly uploads', () => {
    expect(nightlyTarget('new', 'old', { ...complete, isPrerelease: false, assets: [] }, false)?.sha).toBe('new');
  });
});

it('creates a prerelease with the CLI title, notes and exact source target', () => {
  const run = vi.mocked(execFileSync).mockImplementation(((_exe: unknown, args: string[]) => {
    if (args[0] === 'api') throw Object.assign(new Error('missing'), { stderr: Buffer.from('gh: Not Found (HTTP 404)') });
    return '';
  }) as typeof execFileSync);
  ensureNightlyRelease({ sha: 'abc', version: '0.1.0', tag: 'v0.1.0', title: 'Spillway 0.1.0', notes: 'Spillway 0.1.0 nightly' });
  expect(run).toHaveBeenLastCalledWith('gh', ['release', 'create', 'v0.1.0', '--prerelease', '--title', 'Spillway 0.1.0', '--notes', 'Spillway 0.1.0 nightly', '--target', 'abc', '--repo', 'Cujuju/spillway'], expect.anything());
});

it('never recreates an existing nightly or changes a stable release', () => {
  const run = vi.mocked(execFileSync).mockImplementation(((exe: string) => exe === 'git' ? 'abc' : JSON.stringify({ tag_name: 'v0.1.0', prerelease: true, assets: [] })) as typeof execFileSync);
  const details = { sha: 'abc', version: '0.1.0', tag: 'v0.1.0', title: 'Spillway 0.1.0', notes: 'Spillway 0.1.0 nightly' };
  expect(ensureNightlyRelease(details)?.isPrerelease).toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  run.mockReturnValue(JSON.stringify({ tag_name: 'v0.1.0', prerelease: false, assets: [] }));
  expect(() => ensureNightlyRelease(details)).toThrow('already stable');
});

it('does not turn an authentication failure into a release creation', () => {
  const run = vi.mocked(execFileSync).mockImplementation(() => { throw new Error('HTTP 401'); });
  expect(() => ensureNightlyRelease({ sha: 'abc', version: '0', tag: 'v0', title: 'Spillway 0', notes: 'nightly' })).toThrow('HTTP 401');
  expect(run).toHaveBeenCalledTimes(1);
});

it('names all full installers including both Mac zip archives and the Linux AppImage', () => {
  expect(installerFiles('win32', '0.1.0')).toEqual(['Spillway-Setup-0.1.0.exe']);
  expect(installerFiles('linux', '0.1.0')).toEqual(['Spillway-0.1.0-x64.AppImage']);
  expect(installerFiles('darwin', '0.1.0')).toEqual(['Spillway-0.1.0-arm64.dmg', 'Spillway-0.1.0-arm64-mac.zip', 'Spillway-0.1.0-x64.dmg', 'Spillway-0.1.0-x64-mac.zip']);
});

it('restores missing origin/HEAD for clean CI siblings and still rejects dirty or stale siblings', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'spillway-release-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const desktop = path.join(root, 'spillway');
  mkdirSync(desktop);
  try {
    for (const name of ['solidjs-toolkit', 'CLIProxyAPI']) {
      const remote = path.join(root, `${name}-remote`);
      mkdirSync(remote);
      git(remote, 'init', '-q', '-b', 'main');
      writeFileSync(path.join(remote, 'tracked'), 'initial');
      git(remote, 'add', 'tracked');
      git(remote, 'commit', '-qm', 'feat: initial');
      git(root, 'clone', '-q', remote, name);
      git(path.join(root, name), 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    }
    assertReleaseSiblings(desktop);
    const toolkit = path.join(root, 'solidjs-toolkit');
    const details = releaseDetails('HEAD', toolkit);
    expect(details).toMatchObject({ version: '0.1.0', title: 'Spillway 0.1.0', notes: 'Spillway 0.1.0 nightly' });
    expect(git(toolkit, 'rev-parse', 'origin/HEAD')).toBe(details.sha);
    writeFileSync(path.join(toolkit, 'tracked'), 'dirty');
    expect(() => assertReleaseSiblings(desktop)).toThrow('not clean');
    git(toolkit, 'checkout', '--', 'tracked');
    git(toolkit, 'commit', '-qm', 'fix: unpushed', '--allow-empty');
    expect(() => assertReleaseSiblings(desktop)).toThrow('not clean');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, GIT_TEST_TIMEOUT_MS);
