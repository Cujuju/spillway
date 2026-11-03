import { beforeEach, expect, it, vi } from 'vitest';
import { INVOKE } from '@shared/ipc';
import { normalizeSettings, type AppSettings } from '@shared/settings';

let settings: AppSettings;
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const restart = vi.fn<() => Promise<void>>();
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() } }));
vi.mock('./settingsStore', () => ({ getSettings: () => settings, setSettings: (next: AppSettings) => (settings = normalizeSettings(next)) }));
vi.mock('./proxySupervisor', () => ({ proxy: { isRunning: () => true, restart, applyConfig: vi.fn() } }));
vi.mock('./usagePoller', () => ({ usage: { start: vi.fn() } }));
vi.mock('./activityService', () => ({}));
vi.mock('./apiProviders', () => ({}));
vi.mock('./upstreamModels', () => ({}));
vi.mock('./clientSetup', () => ({}));
vi.mock('./codexProcesses', () => ({}));
vi.mock('./clientDriftService', () => ({}));
vi.mock('./managedPolicy', () => ({}));
vi.mock('./credentialFiles', () => ({}));
vi.mock('./historyStore', () => ({}));
vi.mock('./managementClient', () => ({}));
vi.mock('./paths', () => ({}));
vi.mock('./proxyLaunch', () => ({}));
vi.mock('./proxyIdentity', () => ({}));
vi.mock('./quit', () => ({}));
vi.mock('./tray', () => ({}));
vi.mock('./updater', () => ({}));
vi.mock('./windowStarter', () => ({}));
vi.mock('./window', () => ({}));
const { registerIpc } = await import('./ipc');

beforeEach(() => {
  settings = normalizeSettings({});
  handlers.clear();
  restart.mockReset();
  registerIpc();
});

it('returns current settings after a restart instead of overwriting a later save with the old reply', async () => {
  let release!: () => void;
  restart.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  const save = (next: AppSettings) => handlers.get(INVOKE.setSettings)!(null, next) as Promise<AppSettings>;
  const first = save({ ...settings, proxy: { ...settings.proxy, port: 9000 } });
  expect(restart).toHaveBeenCalledOnce();
  const latest = await save({ ...settings, general: { ...settings.general, theme: 'nord' } });
  release();
  expect(await first).toEqual(latest);
  expect((await first).general.theme).toBe('nord');
  expect(settings.proxy.port).toBe(9000);
});
