import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: false,
  commandLine: { getSwitchValue: () => '' }, getAppPath: () => '/workspace/spillway', setPath: vi.fn() } }));
vi.mock('electron', () => electron);
afterEach(() => { vi.unstubAllGlobals(); electron.app.isPackaged = false; });

it('resolves the Linux development binary and packaged bin without an exe suffix', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64', resourcesPath: '/opt/spillway/resources' });
  const { bundledProxyPath, PROXY_EXE_NAME, shellIconPath } = await import('./paths');
  expect(PROXY_EXE_NAME).toBe('cli-proxy-api');
  expect(bundledProxyPath()).toBe(path.join('/workspace/spillway', 'resources/bin/linux-x64/cli-proxy-api'));
  expect(shellIconPath()).toBe(path.join('/workspace/spillway', 'resources/icon.png'));
  electron.app.isPackaged = true;
  expect(bundledProxyPath()).toBe(path.join('/opt/spillway/resources', 'bin/cli-proxy-api'));
});
