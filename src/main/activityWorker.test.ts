import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ postMessage: vi.fn(), prune: vi.fn(), start: vi.fn() }));
vi.mock('node:worker_threads', () => ({ parentPort: Object.assign(new EventEmitter(), { postMessage: state.postMessage }), workerData: {} }));
vi.mock('./activityStore', () => ({ ActivityLog: class { prune = state.prune; } }));
vi.mock('./clientLogSync', () => ({ startClientLogSync: state.start }));
vi.mock('./conversationNames', () => ({ conversationNames: {} }));
it('invalidates renderer after each initialization even when checkpointed scans change nothing', async () => {
  for (let boot = 0; boot < 2; boot++) {
    vi.resetModules();
    await import('./activityWorker');
    expect(state.postMessage).toHaveBeenCalledTimes(boot + 1);
    expect(state.postMessage).toHaveBeenLastCalledWith({ event: 'reset' });
  }
});
