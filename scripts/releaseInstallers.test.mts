import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { additionalInstallerFiles, gh, installerFiles, releaseDetails, releaseView, ROOT } from './releaseShared.mts';

vi.mock('node:fs', { spy: true });
vi.mock('./releaseShared.mts', async (original) => ({
  ...await original<typeof import('./releaseShared.mts')>(),
  gh: vi.fn(), releaseDetails: vi.fn(), releaseView: vi.fn(),
}));

const version = '0.1.0';
const tag = `v${version}`;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('RELEASE_TAG', tag);
  vi.mocked(releaseDetails).mockReturnValue({ sha: 'released', version, tag, title: 'Spillway', notes: 'nightly' });
  vi.mocked(releaseView).mockReturnValue({ tagName: tag, isPrerelease: false,
    assets: [...installerFiles('win32', version), ...installerFiles('linux', version),
      'update-win32.json', 'update-linux.json', 'update-darwin.json'].map((name) => ({ name })) });
  vi.mocked(existsSync).mockReturnValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['win32', 'linux'] as const)('preserves the nightly %s installer referenced by signed indexes', async (platform) => {
  vi.stubGlobal('process', { ...process, platform });
  expect(additionalInstallerFiles(platform, version)).toEqual([]);
  await import('./releaseInstallers.mts');
  expect(gh).not.toHaveBeenCalled();
  expect(existsSync).not.toHaveBeenCalled();
});

it('attaches only additional macOS installers without replacing existing assets', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  const files = installerFiles('darwin', version);
  vi.mocked(releaseView).mockReturnValue({ tagName: tag, isPrerelease: false, assets: [{ name: files[0]! }] });
  await import('./releaseInstallers.mts');
  expect(gh).toHaveBeenCalledExactlyOnceWith(['release', 'upload', tag, ...files.slice(1).map((f) => path.join(ROOT, 'dist', f))]);
});

it('does nothing when the additional installers are already attached', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  vi.mocked(releaseView).mockReturnValue({ tagName: tag, isPrerelease: false,
    assets: installerFiles('darwin', version).map((name) => ({ name })) });
  await import('./releaseInstallers.mts');
  expect(gh).not.toHaveBeenCalled();
});

it('rejects missing additional installers before uploading', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  vi.mocked(existsSync).mockReturnValue(false);
  await expect(import('./releaseInstallers.mts')).rejects.toThrow('Missing installer');
  expect(gh).not.toHaveBeenCalled();
});
