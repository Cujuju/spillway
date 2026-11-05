import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ postMessage: vi.fn(), prune: vi.fn(), start: vi.fn(), exportReset: vi.fn(), exportError: vi.fn() }));
vi.mock('node:worker_threads', () => ({ parentPort: Object.assign(new EventEmitter(), { postMessage: state.postMessage }), workerData: {} }));
vi.mock('./activityStore', () => ({ ActivityLog: class { prune = state.prune; archiveExportReset = state.exportReset; archiveExportStartupError = state.exportError; } }));
vi.mock('./clientLogSync', () => ({ startClientLogSync: state.start }));
vi.mock('./conversationNames', () => ({ conversationNames: {} }));
it('invalidates renderer after each initialization even when checkpointed scans change nothing', async () => {
  for (let boot = 0; boot < 2; boot++) {
    vi.resetModules();
    await import('./activityWorker');
    expect(state.postMessage).toHaveBeenCalledTimes(boot + 1);
    expect(state.postMessage).toHaveBeenLastCalledWith({ event: 'reset' });
    expect(state.exportReset).toHaveBeenCalledTimes(boot + 1);
  }
});
it('continues worker initialization when portable export recovery unexpectedly fails', async () => {
  vi.resetModules(); state.postMessage.mockClear();
  state.exportReset.mockImplementationOnce(() => { throw new Error('export recovery unavailable'); });
  await import('./activityWorker');
  expect(state.exportError).toHaveBeenLastCalledWith(expect.stringContaining('export recovery unavailable'));
  expect(state.postMessage).toHaveBeenCalledWith({ event: 'reset' });
});
