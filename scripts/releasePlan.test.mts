import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureNightlyRelease, gh, git, RELEASE_ARCHS, releaseDetails } from './releaseShared.mts';

vi.mock('./releaseShared.mts', async (original) => ({
  ...await original<typeof import('./releaseShared.mts')>(),
  gh: vi.fn(), git: vi.fn(), releaseDetails: vi.fn(), ensureNightlyRelease: vi.fn(),
}));
let dir: string;
let assets: { name: string }[];
const details = { sha: 'released', version: '0.1.0', tag: 'v0.1.0', title: 'Spillway 0.1.0', notes: 'Spillway 0.1.0 nightly' };
const mainDetails = { sha: 'main', version: '0.1.1', tag: 'v0.1.1', title: 'Spillway 0.1.1', notes: 'Spillway 0.1.1 nightly' };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-plan-'));
  vi.stubEnv('GITHUB_OUTPUT', path.join(dir, 'outputs'));
  vi.stubEnv('GITHUB_EVENT_NAME', 'schedule');
  vi.stubEnv('RELEASE_MODE', 'nightly'); vi.stubEnv('RELEASE_TAG', '');
  assets = Object.keys(RELEASE_ARCHS).map((p) => ({ name: `update-${p}.json` }));
  vi.mocked(git).mockImplementation((args) => args[0] === 'rev-list' ? 'released' : 'main');
  vi.mocked(gh).mockImplementation((args) => JSON.stringify(args[1] === 'list' ? [{ tagName: 'v0.1.0' }]
    : { tagName: 'v0.1.0', isPrerelease: true, assets }));
  vi.mocked(releaseDetails).mockImplementation((sha) => sha === 'main' ? mainDetails : details);
  vi.mocked(ensureNightlyRelease).mockReturnValue(null);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

async function outputs() {
  await import('./releasePlan.mts');
  return Object.fromEntries(readFileSync(path.join(dir, 'outputs'), 'utf8').trim().split('\n').map((line) => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
}

it('emits the exact new source SHA and three build hosts after preparing one release', async () => {
  const output = await outputs();
  expect(output.sha).toBe('main');
  expect(JSON.parse(output.matrix!).include.map((b: { os: string }) => b.os)).toEqual(['windows-latest', 'macos-latest', 'ubuntu-latest']);
  expect(ensureNightlyRelease).toHaveBeenCalledExactlyOnceWith(mainDetails);
});

it('resumes only missing platforms while main matches the prerelease source', async () => {
  assets = assets.filter((a) => a.name !== 'update-linux.json');
  vi.mocked(git).mockReturnValue('released');
  const output = await outputs();
  expect(output.sha).toBe('released');
  expect(JSON.parse(output.matrix!).include).toEqual([{ os: 'ubuntu-latest', platform: 'linux', proxyTargets: 'linux-x64', published: false }]);
  expect(ensureNightlyRelease).toHaveBeenCalledExactlyOnceWith(details);
});

it('supersedes a partial prerelease with advanced main for every platform without changing the old release', async () => {
  assets = [{ name: 'update-darwin.json' }];
  const output = await outputs();
  expect(output).toMatchObject({ run: 'true', sha: mainDetails.sha, tag: mainDetails.tag });
  expect(JSON.parse(output.matrix!).include).toEqual([
    { os: 'windows-latest', platform: 'win32', proxyTargets: 'win32-x64', published: false },
    { os: 'macos-latest', platform: 'darwin', proxyTargets: 'darwin-arm64 darwin-x64', published: false },
    { os: 'ubuntu-latest', platform: 'linux', proxyTargets: 'linux-x64', published: false },
  ]);
  expect(ensureNightlyRelease).toHaveBeenCalledExactlyOnceWith(mainDetails);
  expect(vi.mocked(gh).mock.calls.every(([args]) => args[0] === 'release' && ['list', 'view'].includes(args[1]!))).toBe(true);
});

it('skips unchanged scheduled releases before any create call', async () => {
  vi.mocked(git).mockReturnValue('released');
  expect(await outputs()).toEqual({ run: 'false' });
  expect(ensureNightlyRelease).not.toHaveBeenCalled();
});

it('allows a manual rebuild while preserving completed platform uploads', async () => {
  vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
  vi.mocked(git).mockReturnValue('released');
  vi.mocked(ensureNightlyRelease).mockReturnValue({ tagName: 'v0.1.0', isPrerelease: true, assets });
  const output = await outputs();
  expect(output.run).toBe('true');
  expect(JSON.parse(output.matrix!).include.every((b: { published: boolean }) => b.published)).toBe(true);
});

it('builds stable installers from the selected tag instead of main without creating a release', async () => {
  vi.stubEnv('RELEASE_MODE', 'installers'); vi.stubEnv('RELEASE_TAG', 'v0.1.0');
  vi.mocked(gh).mockReturnValue(JSON.stringify({ tagName: 'v0.1.0', isPrerelease: false }));
  vi.mocked(releaseDetails).mockReturnValue(details);
  const output = await outputs();
  expect(releaseDetails).toHaveBeenCalledWith('v0.1.0');
  expect(output).toMatchObject({ sha: 'released', tag: 'v0.1.0', mode: 'installers' });
  expect(ensureNightlyRelease).not.toHaveBeenCalled();
});

it('rejects installer publication for an unpromoted release', async () => {
  vi.stubEnv('RELEASE_MODE', 'installers');
  await expect(outputs()).rejects.toThrow('Promote the release');
  expect(ensureNightlyRelease).not.toHaveBeenCalled();
});
