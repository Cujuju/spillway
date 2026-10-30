import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./activityService', () => ({ activityLog: {} }));
vi.mock('./managementClient', () => ({ management: {} }));
vi.mock('./usagePoller', () => ({ usage: { poll: vi.fn() } }));
const { activity } = await import('./activityStream');
const { usage } = await import('./usagePoller');
afterEach(() => { void activity.stop(); vi.useRealTimers(); vi.clearAllMocks(); });
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

it('waits for buffered stream messages before stopping on shutdown', async () => {
  let finish!: () => void;
  const stream = activity as unknown as { reading: Promise<void> };
  stream.reading = new Promise<void>((resolve) => { finish = resolve; });
  let stopped = false;
  const stopping = activity.stop(true).then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish();
  await stopping;
  expect(stopped).toBe(true);
});
it('still stops when the final stream read fails', async () => {
  const stream = activity as unknown as { reading: Promise<void> };
  stream.reading = Promise.reject(new Error('connection closed'));
  await expect(activity.stop(true)).resolves.toBeUndefined();
});
