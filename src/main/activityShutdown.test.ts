import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityRpc, type RpcPort } from './activityRpc';
import { drainActivity, ACTIVITY_QUIT_DEADLINE_MS } from './activityShutdown';
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
