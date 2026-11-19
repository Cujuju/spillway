import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityRpc, type RpcPort } from './activityRpc';
import { drainActivity, ACTIVITY_QUIT_DEADLINE_MS, ACTIVITY_WORKER_CLOSE_GRACE_MS } from './activityShutdown';
import type { Request } from './activityProtocol';
afterEach(() => vi.useRealTimers());
for (const failure of ['disk full', 'startup failure', 'stalled reader', 'stalled proxy']) {
  it(`quits within one deadline after ${failure} and cancels retries`, async () => {
    vi.useFakeTimers();
    class Port extends EventEmitter implements RpcPort {
      terminate = vi.fn();
      postMessage(r: Request): void { this.emit('message', { id: r.id, error: 'disk full' }); }
    }
    const port = new Port();
    const factory = vi.fn(() => { if (failure === 'startup failure') throw new Error(failure); return port; });
    const rpc = new ActivityRpc(factory);
    rpc.start();
    const write = rpc.call('append', {} as import('@shared/types').ActivityEvent).catch(() => null);
    const stop = vi.fn(() => failure === 'stalled reader' ? new Promise<void>(() => {}) : Promise.resolve());
    const report = vi.fn();
    const quit = vi.fn();
    const draining = drainActivity(() => failure === 'stalled proxy' ? new Promise<void>(() => {}) : Promise.resolve(), stop, rpc, report).finally(quit);
    await vi.advanceTimersByTimeAsync(ACTIVITY_QUIT_DEADLINE_MS);
    await draining;
    expect(quit).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.stringContaining('1 unacknowledged'));
    const attempts = factory.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ACTIVITY_QUIT_DEADLINE_MS);
    expect(factory).toHaveBeenCalledTimes(attempts);
    await write;
    await expect(rpc.call('days')).rejects.toThrow('closed');
  });
}

it('lets a responsive worker close (stopping its file watchers) before the deadline path terminates it', async () => {
  vi.useFakeTimers();
  const methods: string[] = [];
  class Port extends EventEmitter implements RpcPort {
    terminate = vi.fn();
    postMessage(r: Request): void {
      methods.push(r.method);
      queueMicrotask(() => this.emit('message', { id: r.id, value: r.method === 'days' ? [] : undefined }));
    }
  }
  const port = new Port();
  const rpc = new ActivityRpc(() => port);
  rpc.start();
  await rpc.call('days');
  // The event stream never ends: an attached proxy the app doesn't stop.
  const draining = drainActivity(() => Promise.resolve(), () => new Promise<void>(() => {}), rpc, vi.fn());
  await vi.advanceTimersByTimeAsync(ACTIVITY_QUIT_DEADLINE_MS);
  await draining;
  expect(methods).toEqual(['days', 'close']);
  expect(port.terminate).not.toHaveBeenCalled();
});

it('terminates a worker that does not close within the grace period', async () => {
  vi.useFakeTimers();
  class Port extends EventEmitter implements RpcPort {
    terminate = vi.fn();
    postMessage(): void { /* never answers */ }
  }
  const port = new Port();
  const rpc = new ActivityRpc(() => port);
  rpc.start();
  const done = vi.fn();
  void drainActivity(() => Promise.resolve(), () => new Promise<void>(() => {}), rpc, vi.fn()).then(done);
  await vi.advanceTimersByTimeAsync(ACTIVITY_QUIT_DEADLINE_MS);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(ACTIVITY_WORKER_CLOSE_GRACE_MS);
  expect(done).toHaveBeenCalledOnce();
  expect(port.terminate).toHaveBeenCalledOnce();
});
