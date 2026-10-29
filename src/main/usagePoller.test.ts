import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ Notification: {} }));
vi.mock('./historyStore', () => ({ history: { add: vi.fn() } }));
vi.mock('./managementClient', () => ({ management: { usage: vi.fn() } }));
vi.mock('./proxySupervisor', () => ({ proxy: { isRunning: () => true } }));
vi.mock('./settingsStore', () => ({ getSettings: vi.fn() }));
vi.mock('./paths', () => ({ appIconPath: vi.fn() }));
vi.mock('./usageEvents', () => ({ diffUsage: () => [] }));
const { usage } = await import('./usagePoller');
const { management } = await import('./managementClient');
const snapshot = { strategy: 'soonest-reset', fetchedAt: new Date().toISOString(), credentials: [] };
afterEach(() => { vi.clearAllMocks(); });
it('coalesces triggers during a poll into one follow-up after it completes', async () => {
  let complete!: (value: typeof snapshot) => void;
  vi.mocked(management.usage).mockImplementationOnce(() => new Promise((r) => { complete = r; }))
    .mockResolvedValue(snapshot as Awaited<ReturnType<typeof management.usage>>);
  const first = usage.poll();
  await usage.poll();
  await usage.poll();
  expect(management.usage).toHaveBeenCalledTimes(1);
  complete(snapshot);
  await first;
  expect(management.usage).toHaveBeenCalledTimes(2);
});
