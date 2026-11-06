import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./notifier', () => ({ notify: vi.fn() }));
vi.mock('./historyStore', () => ({ history: { add: vi.fn() } }));
vi.mock('./managementClient', async (original) => ({
  ...await original<typeof import('./managementClient')>(),
  management: { usage: vi.fn(), refreshUsage: vi.fn(), useResetCredit: vi.fn(), startWindow: vi.fn() },
}));
vi.mock('./proxySupervisor', () => ({ proxy: { isRunning: () => true } }));
vi.mock('./settingsStore', () => ({ getSettings: vi.fn() }));
vi.mock('./usageEvents', () => ({ diffUsage: () => [] }));
const { usage } = await import('./usagePoller');
const { management, UsageRefreshError } = await import('./managementClient');
const snapshot = { strategy: 'soonest-reset', fetchedAt: new Date().toISOString(), credentials: [] };
const newer = { ...snapshot, strategy: 'newer' };
usage.on('error', () => undefined);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { usage.removeAllListeners('snapshot'); vi.clearAllMocks(); });
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
  await vi.waitFor(() => expect(management.usage).toHaveBeenCalledTimes(2));
});

it('discards a cache read that returns after a newer refresh and polls again', async () => {
  const pending = deferred<typeof snapshot>();
  vi.mocked(management.usage).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(newer);
  vi.mocked(management.refreshUsage).mockResolvedValueOnce(newer);
  const published = vi.fn();
  usage.on('snapshot', published);
  const read = usage.poll();
  await usage.refresh();
  pending.resolve(snapshot);
  await read;
  await vi.waitFor(() => expect(management.usage).toHaveBeenCalledTimes(2));
  expect(usage.latest()).toEqual(newer);
  expect(published.mock.calls.every(([value]) => value.strategy === newer.strategy)).toBe(true);
});

it('keeps reading live cache data while a provider refresh is in progress', async () => {
  const pending = deferred<typeof snapshot>();
  vi.mocked(management.refreshUsage).mockReturnValueOnce(pending.promise);
  vi.mocked(management.usage).mockResolvedValueOnce(snapshot);
  const refresh = usage.refresh();
  await usage.poll();
  expect(management.usage).toHaveBeenCalledOnce();
  expect(usage.latest()).toEqual(snapshot);
  pending.resolve(newer);
  await refresh;
  expect(usage.latest()).toEqual(newer);
});

it('publishes partial results and exposes a refresh failure, then recovers', async () => {
  const error = new UsageRefreshError(newer, ['HTTP 429']);
  vi.mocked(management.refreshUsage).mockRejectedValueOnce(error).mockResolvedValueOnce(snapshot);
  await expect(usage.refresh()).rejects.toBe(error);
  expect(usage.latest()).toEqual(newer);
  expect(usage.lastError).toContain('HTTP 429');
  await usage.refresh();
  expect(usage.latest()).toEqual(snapshot);
  expect(usage.lastError).toBeNull();
});

it('orders quota mutations without blocking live cache reads', async () => {
  const pending = deferred<{ outcome: 'reset'; snapshot: typeof snapshot }>();
  vi.mocked(management.useResetCredit).mockReturnValueOnce(pending.promise);
  vi.mocked(management.startWindow).mockResolvedValueOnce(newer);
  vi.mocked(management.usage).mockResolvedValueOnce(newer);
  const reset = usage.useResetCredit('a');
  const start = usage.startWindow('a', 'model');
  await usage.poll();
  expect(management.startWindow).not.toHaveBeenCalled();
  expect(management.usage).toHaveBeenCalledOnce();
  pending.resolve({ outcome: 'reset', snapshot });
  expect(await reset).toBe('reset');
  await start;
  expect(usage.latest()).toEqual(newer);
});

it('does not publish a stale read error after a successful refresh', async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(management.usage).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; })).mockResolvedValueOnce(newer);
  vi.mocked(management.refreshUsage).mockResolvedValueOnce(newer);
  const read = usage.poll();
  await usage.refresh();
  reject(new Error('old cache read failed'));
  await read;
  await vi.waitFor(() => expect(management.usage).toHaveBeenCalledTimes(2));
  expect(usage.lastError).toBeNull();
  expect(usage.latest()).toEqual(newer);
});
