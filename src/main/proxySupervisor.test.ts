import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import { parseBuildInfo } from '@shared/buildInfo';

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(readonly pid: number | undefined) { super(); }
  kill = vi.fn(() => { this.emit('exit', 0, null); return true; });
}
let settings: AppSettings;
const children: Child[] = [];
const spawn = vi.fn(() => {
  const child = new Child(children.length + 1);
  children.push(child);
  return child;
});
const ping = vi.fn();
const shutdown = vi.fn(async () => { children.at(-1)?.emit('exit', 0, null); return true; });
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('node:fs', () => ({ existsSync: () => false, createWriteStream: () => ({ write: vi.fn(), end: vi.fn() }) }));
vi.mock('electron', () => ({ app: { commandLine: { getSwitchValue: () => '' } } }));
vi.mock('./paths', () => ({ appPaths: {}, resolveProxyExecutable: () => 'test-proxy' }));
vi.mock('./proxyLaunch', () => ({
  newSupervisorPassword: () => 'test-password', portInUse: async () => false, SUPERVISOR_PASSWORD_ENV: 'TEST_PASSWORD',
  watchUserConfig: () => ({}), writeProxyConfig: () => null,
}));
vi.mock('./settingsStore', () => ({ getSettings: () => settings }));
vi.mock('./managementClient', () => ({ management: { configure: vi.fn(), ping, shutdown } }));

let proxy: (typeof import('./proxySupervisor'))['proxy'];
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  children.length = 0;
  settings = normalizeSettings({});
  ping.mockResolvedValue(parseBuildInfo('1', 'test', null));
  ({ proxy } = await import('./proxySupervisor'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('proxy lifecycle', () => {
  it('releases an asynchronously failed spawn without needing an exit event', async () => {
    const failed = new Child(undefined);
    spawn.mockReturnValueOnce(failed);
    ping.mockResolvedValueOnce(null);
    const starting = proxy.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    failed.emit('error', new Error('ENOENT'));
    failed.emit('close', -1, null);
    await vi.advanceTimersByTimeAsync(250);
    await starting;
    expect(proxy.getStatus()).toMatchObject({ state: 'crashed', pid: null, lastError: 'ENOENT' });
    await proxy.stop();
    await proxy.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(proxy.isRunning()).toBe(true);
    failed.emit('error', new Error('late old error'));
    expect(proxy.isRunning()).toBe(true);
    await proxy.stop();
    expect(proxy.getStatus().state).toBe('stopped');
  });

  it('retains a live child on a non-spawn error', async () => {
    await proxy.start();
    const pid = proxy.getStatus().pid;
    children[0]!.emit('error', new Error('kill failed'));
    await proxy.start();
    expect(spawn).toHaveBeenCalledOnce();
    expect(proxy.getStatus()).toMatchObject({ state: 'running', pid, lastError: 'kill failed' });
    await proxy.stop();
    expect(proxy.getStatus().state).toBe('stopped');
  });

  it('does not restart when automatic restart is disabled during backoff', async () => {
    await proxy.start();
    children[0]!.emit('exit', 1, null);
    settings = normalizeSettings({ ...settings, proxy: { ...settings.proxy, restartOnCrash: false } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledOnce();
    expect(proxy.getStatus().state).toBe('crashed');
  });

  it('cancels a pending restart when stopped with no child', async () => {
    await proxy.start();
    children[0]!.emit('exit', 1, null);
    await proxy.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(spawn).toHaveBeenCalledOnce();
    expect(proxy.getStatus().state).toBe('stopped');
  });

  it('still restarts a crashed proxy when enabled', async () => {
    await proxy.start();
    children[0]!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(proxy.isRunning()).toBe(true);
    await proxy.stop();
  });
});
