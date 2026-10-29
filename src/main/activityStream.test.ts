import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./activityLog', () => ({ activityLog: {} }));
vi.mock('./managementClient', () => ({ management: {} }));
vi.mock('./usagePoller', () => ({ usage: { poll: vi.fn() } }));
const { activity } = await import('./activityStream');
const { usage } = await import('./usagePoller');
afterEach(() => { activity.stop(); vi.useRealTimers(); vi.clearAllMocks(); });
it('polls within two seconds of the first event under continuous traffic', async () => {
  vi.useFakeTimers();
  const stream = activity as unknown as { onMessage(event: string, data: string): void };
  stream.onMessage('usage', '{}');
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(500);
    stream.onMessage('usage', '{}');
  }
  expect(usage.poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(usage.poll).toHaveBeenCalledTimes(2);
});
