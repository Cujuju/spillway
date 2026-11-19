import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import { parseBuildInfo } from '@shared/buildInfo';

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(readonly pid: number | undefined) { super(); }
  kill = vi.fn((_signal?: NodeJS.Signals) => { this.emit('exit', 0, null); return true; });
}
let settings: AppSettings;
const journalDatabaseKey = randomBytes(32).toString('hex');
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
vi.mock('./proxyLaunch', async (importOriginal) => ({
  captureJournalKey: (await importOriginal<typeof import('./proxyLaunch')>()).captureJournalKey,
  newSupervisorPassword: () => 'test-password', portInUse: async () => false, SUPERVISOR_PASSWORD_ENV: 'TEST_PASSWORD',
  watchUserConfig: () => ({}), writeProxyConfig: () => null,
}));
vi.mock('./settingsStore', () => ({ getSettings: () => settings, getSecrets: () => ({ databaseKey: journalDatabaseKey }) }));
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

  it('marks a live proxy running when it answers after the startup window', async () => {
    ping.mockResolvedValue(null);
    const starting = proxy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await starting;
    expect(proxy.getStatus()).toMatchObject({ state: 'starting', pid: 1, lastError: 'Proxy did not become ready' });
    ping.mockResolvedValue(parseBuildInfo('1', 'test', null));
    await vi.advanceTimersByTimeAsync(250);
    expect(proxy.getStatus()).toMatchObject({ state: 'running', pid: 1, lastError: null });
    expect(spawn).toHaveBeenCalledOnce();
    await proxy.stop();
    expect(proxy.getStatus().state).toBe('stopped');
  });

  it('stops watching a slow proxy that exits before answering', async () => {
    ping.mockResolvedValue(null);
    settings = normalizeSettings({ ...settings, proxy: { ...settings.proxy, restartOnCrash: false } });
    const starting = proxy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await starting;
    children[0]!.emit('exit', 1, null);
    ping.mockResolvedValue(parseBuildInfo('1', 'test', null));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(proxy.getStatus().state).toBe('crashed');
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

  it('hard-kills a proxy that ignores the shutdown request and SIGTERM, and never waits forever', async () => {
    await proxy.start();
    const child = children[0]!;
    shutdown.mockResolvedValueOnce(false);
    // POSIX semantics: the proxy handles SIGTERM, so only SIGKILL ends it.
    child.kill.mockImplementation((signal?: NodeJS.Signals) => { if (signal === 'SIGKILL') child.emit('exit', null, 'SIGKILL'); return true; });
    const stopping = proxy.stop();
    await vi.advanceTimersByTimeAsync(8_000);
    await stopping;
    expect(child.kill.mock.calls).toEqual([['SIGKILL']]);
    expect(proxy.getStatus().state).toBe('stopped');

    await proxy.start();
    const stuck = children[1]!;
    shutdown.mockResolvedValueOnce(false);
    stuck.kill.mockImplementation(() => true);
    const stuckStop = proxy.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await stuckStop;
    expect(proxy.getStatus().lastError).toMatch(/did not exit after SIGKILL/);
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
