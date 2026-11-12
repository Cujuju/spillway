import { beforeEach, expect, it, vi } from 'vitest';
import { INVOKE } from '@shared/ipc';
import { normalizeSettings, type AppSettings } from '@shared/settings';

let settings: AppSettings;
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const restart = vi.fn<() => Promise<void>>();
const archiveMocks = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), on: vi.fn() } }));
vi.mock('./settingsStore', () => ({ getSettings: () => settings, setSettings: (next: AppSettings) => (settings = normalizeSettings(next)) }));
vi.mock('./proxySupervisor', () => ({ proxy: { isRunning: () => true, restart, applyConfig: vi.fn() } }));
const thinkingMocks = vi.hoisted(() => ({ latest: vi.fn(), credentialModels: vi.fn() }));
vi.mock('./usagePoller', () => ({ usage: { start: vi.fn(), latest: thinkingMocks.latest } }));
vi.mock('./activityService', () => ({ activityLog: { call: archiveMocks.call } }));
vi.mock('./archiveSync', () => ({ archiveSync: { refresh: archiveMocks.refresh } }));
vi.mock('./diagnosticService', () => ({ diagnosticExporter: {} }));
vi.mock('./evalService', () => ({ evalReplay: {}, forgetEvalExport: vi.fn(), invalidateEval: vi.fn(), importEvalFile: vi.fn(), prepareEvalExport: vi.fn(), prepareEvalReplay: vi.fn(), saveEvalExport: vi.fn(), withEvalDeletion: (fn: () => Promise<unknown>) => fn() }));
vi.mock('./apiProviders', () => ({}));
vi.mock('./upstreamModels', () => ({}));
vi.mock('./clientSetup', () => ({}));
vi.mock('./codexProcesses', () => ({}));
vi.mock('./clientDriftService', () => ({}));
vi.mock('./managedPolicy', () => ({}));
vi.mock('./credentialFiles', () => ({}));
vi.mock('./historyStore', () => ({}));
vi.mock('./managementClient', () => ({ management: { credentialModels: thinkingMocks.credentialModels } }));
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
  archiveMocks.call.mockReset(); archiveMocks.refresh.mockReset();
  registerIpc();
});

it('deleting archive preserves retention/budget and disables capture before clearing data', async () => {
  const policy = { captureBodies: true, retentionDays: 33, maxBytes: 9 * 1024 * 1024 };
  archiveMocks.call.mockResolvedValue({ policy });
  await handlers.get(INVOKE.archiveClear)!(null);
  expect(archiveMocks.call.mock.calls).toEqual([['archiveStatus'], ['archivePolicy', { ...policy, captureBodies: false }], ['archiveClear']]);
  expect(archiveMocks.refresh).toHaveBeenCalledOnce();
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


it.each([false, true])('returns thinking with failed model lists omitted (all fail: %s)', async (allFail) => {
  thinkingMocks.latest.mockReturnValue({ credentials: [{ name: 'bad', provider: 'codex' }, { name: 'good', provider: 'claude' }] });
  const failure = new Error('proxy unavailable');
  thinkingMocks.credentialModels.mockImplementation(async (name) => {
    if (name === 'bad' || allFail) throw failure;
    return [{ id: 'claude-sonnet-5-5', created: 123 }];
  });
  const result = { settings: [], untracked: { requests: 0, costUsd: 0 } };
  archiveMocks.call.mockResolvedValue(result);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const query = { from: 0, to: 1, scope: { accounts: null, clients: null } };
  try {
    expect(await handlers.get(INVOKE.activityThinking)!(null, query)).toEqual(result);
    expect(archiveMocks.call).toHaveBeenCalledWith('thinking', query,
      allFail ? [] : [{ id: 'claude-sonnet-5-5', created: 123, provider: 'claude' }]);
    expect(error).toHaveBeenCalledTimes(allFail ? 2 : 1);
    expect(error).toHaveBeenCalledWith('Thinking credential models failed', 'bad', failure);
  } finally { error.mockRestore(); }
});
