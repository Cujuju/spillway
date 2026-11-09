import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  settings: { canary: { enabled: true, intervalHours: 6, targets: [{ model: 'opus', effort: 'high' }] } },
  running: true, changes: [] as (() => void)[], status: [] as (() => void)[], save: vi.fn(async (..._args: unknown[]) => undefined), lastRunAt: null as string | null, ambiguous: false, snapshotReady: true,
}));
vi.mock('./settingsStore', () => ({ getSettings: () => state.settings, onSettingsChange: (f: () => void) => state.changes.push(f) }));
vi.mock('./proxySupervisor', () => ({ proxy: { isRunning: () => state.running, getStatus: () => ({ state: state.running ? 'running' : 'stopped', endpoint: 'http://localhost' }), on: (_event: string, f: () => void) => state.status.push(f) } }));
vi.mock('./proxyIdentity', () => ({ proxyIdentity: () => ({ clientApiKeys: ['test-local'] }) }));
vi.mock('./usagePoller', () => ({ usage: { latest: () => state.snapshotReady ? ({ credentials: [{ name: 'test', provider: 'claude' }] }) : null } }));
vi.mock('./managementClient', () => ({ management: { credentialModels: async () => [{ id: 'opus', ownedBy: 'anthropic' }, ...(state.ambiguous ? [{ id: 'unknown', ownedBy: 'anthropic' }, { id: 'unknown', ownedBy: 'openai' }] : [])] } }));
vi.mock('./activityService', () => ({ activityLog: { call: (...args: unknown[]) => args[0] === 'canaryLastRunAt' ? Promise.resolve(state.lastRunAt) : state.save(...args) } }));
vi.mock('./canaryRunner', () => ({ runCanaryProbe: async () => ({ outcome: 'pass', error: null }) }));
import { CanaryService, canaryService, CANARY_SNAPSHOT_RETRY_MS } from './canaryService';
afterEach(() => { state.settings.canary.enabled = false; state.changes.forEach((f) => f()); vi.useRealTimers(); });
it('requires a proxy, schedules fixed intervals, serializes runs and stores every probe', async () => {
  vi.useFakeTimers(); state.running = false;
  expect(() => canaryService.runNow()).toThrow('Start the local proxy');
  state.running = true; await canaryService.attach();
  const due = canaryService.status().nextRunAt;
  expect(due).not.toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(canaryService.status().nextRunAt).toBe(due);
  const first = canaryService.runNow();
  expect(first).toMatchObject({ running: true, callsPerRun: 6 });
  expect(canaryService.runNow().lastRunAt).toBe(first.lastRunAt);
  await vi.advanceTimersByTimeAsync(0);
  expect(state.save).toHaveBeenCalledTimes(6);
  expect(canaryService.status().running).toBe(false);
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
  expect(state.save).toHaveBeenCalledTimes(12);
});

it('seeds scheduling from persisted history across restarts', async () => {
  vi.useFakeTimers();
  state.settings.canary.enabled = true;
  state.lastRunAt = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
  const service = new CanaryService();
  await service.attach();
  expect(service.status().lastRunAt).toBe(state.lastRunAt);
  expect(Date.parse(service.status().nextRunAt!) - Date.now()).toBe(60 * 60_000);
  state.lastRunAt = null;
});
it.each([false, true])('records unresolved targets as errors and continues (ambiguous: %s)', async (ambiguous) => {
  state.ambiguous = ambiguous;
  vi.useFakeTimers(); state.save.mockClear();
  state.settings.canary.targets = [{ model: 'unknown', effort: 'high' }, { model: 'opus', effort: 'high' }];
  const service = new CanaryService();
  service.runNow();
  await vi.advanceTimersByTimeAsync(0);
  const results = state.save.mock.calls.flatMap((args) => args[1] as { model?: string; outcome: string; error: string | null }[]);
  expect(results.filter((r) => r.outcome === 'error')).toHaveLength(6);
  expect(results.filter((r) => r.outcome === 'pass')).toHaveLength(6);
  expect(results[0]).toMatchObject({ model: 'unknown', error: 'Unknown or ambiguous provider for canary model unknown' });
  expect(service.status().running).toBe(false);
  state.settings.canary.targets = [{ model: 'opus', effort: 'high' }];
  state.ambiguous = false;
});

it('defers overdue startup runs until credentials arrive and rejects run-now meanwhile', async () => {
  vi.useFakeTimers(); state.save.mockClear();
  state.settings.canary.enabled = true;
  state.snapshotReady = false;
  state.lastRunAt = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
  const service = new CanaryService();
  try {
    await service.attach();
    expect(() => service.runNow()).toThrow('Wait for a usage snapshot with credentials');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.save).not.toHaveBeenCalled();
    expect(service.status().lastRunAt).toBe(state.lastRunAt);
    expect(Date.parse(service.status().nextRunAt!) - Date.now()).toBe(CANARY_SNAPSHOT_RETRY_MS);
    state.snapshotReady = true;
    await vi.advanceTimersByTimeAsync(CANARY_SNAPSHOT_RETRY_MS);
    expect(state.save).toHaveBeenCalledTimes(6);
    expect(service.status().lastRunAt).not.toBe(state.lastRunAt);
  } finally { state.snapshotReady = true; state.lastRunAt = null; }
});
