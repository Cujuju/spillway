import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ActivityBucket } from '@shared/types';
const state = vi.hoisted(() => ({ postMessage: vi.fn(), prune: vi.fn(), start: vi.fn<typeof import('./clientLogSync').startClientLogSync>(() => () => Promise.resolve()), exportReset: vi.fn(), exportError: vi.fn(), archivePrune: vi.fn(), append: vi.fn(), revision: 0, buckets: [] as ActivityBucket[], watermark: 0 }));
vi.mock('node:worker_threads', () => ({ parentPort: Object.assign(new EventEmitter(), { postMessage: state.postMessage, close: vi.fn() }), workerData: { catalogPrices: {} } }));
vi.mock('./activityStore', () => ({ ActivityLog: class {
  prune = state.prune; archiveExportReset = state.exportReset; archiveExportStartupError = state.exportError;
  archivePrune = state.archivePrune; append = state.append; archiveObserve = vi.fn(); archiveExportDispose = vi.fn(); close = vi.fn();
  get revision() { return state.revision; }
  get lastAppendBuckets() { return state.buckets; }
  get lastAppendWatermark() { return state.watermark; }
} }));
vi.mock('./clientLogSync', () => ({ startClientLogSync: state.start }));
vi.mock('./titleExport', () => ({ startTitleExport: () => ({ stop: vi.fn() }) }));
beforeEach(async () => {
  const { parentPort } = await import('node:worker_threads');
  parentPort!.removeAllListeners();
});
it('invalidates renderer after each initialization even when checkpointed scans change nothing', async () => {
  for (let boot = 0; boot < 2; boot++) {
    vi.resetModules();
    await import('./activityWorker');
    expect(state.postMessage).toHaveBeenCalledTimes(boot + 1);
    expect(state.postMessage).toHaveBeenLastCalledWith({ event: 'reset' });
    expect(state.exportReset).toHaveBeenCalledTimes(boot + 1);
  }
});

it('emits bucket replacements on append, skips replay deltas, and prefers resets on revision changes', async () => {
  vi.resetModules();
  await import('./activityWorker');
  const { parentPort } = await import('node:worker_threads');
  const append = async () => {
    state.postMessage.mockClear();
    parentPort!.emit('message', { id: 1, method: 'append', args: [{}] });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const stored = { id: 10 };
  state.buckets = [{ start: 0, requests: 2 } as ActivityBucket];
  state.watermark = 42;
  state.append.mockReturnValue(stored);
  await append();
  expect(state.postMessage.mock.calls).toEqual([[{ event: 'buckets', value: { watermark: 42, buckets: state.buckets } }], [{ id: 1, value: stored }]]);

  state.buckets = [];
  await append();
  expect(state.postMessage).toHaveBeenCalledExactlyOnceWith({ id: 1, value: stored });

  state.append.mockImplementationOnce(() => { state.revision++; return stored; });
  state.buckets = [{ start: 0 } as ActivityBucket];
  await append();
  expect(state.postMessage.mock.calls).toEqual([[{ event: 'reset' }], [{ id: 1, value: stored }]]);
});

it('runs periodic archive retention and stops it on close', async () => {
  vi.useFakeTimers();
  try {
    vi.resetModules();
    await import('./activityWorker');
    const { parentPort } = await import('node:worker_threads');
    const hour = 60 * 60_000;
    await vi.advanceTimersByTimeAsync(hour);
    expect(state.archivePrune).toHaveBeenCalledTimes(1);
    parentPort!.emit('message', { id: 1, method: 'close', args: [] });
    await vi.advanceTimersByTimeAsync(hour);
    expect(state.archivePrune).toHaveBeenCalledTimes(1);
    expect(state.postMessage).toHaveBeenLastCalledWith({ id: 1, value: undefined });
  } finally { vi.useRealTimers(); }
});
it('continues worker initialization when portable export recovery unexpectedly fails', async () => {
  vi.resetModules(); state.postMessage.mockClear();
  state.exportReset.mockImplementationOnce(() => { throw new Error('export recovery unavailable'); });
  await import('./activityWorker');
  expect(state.exportError).toHaveBeenLastCalledWith(expect.stringContaining('export recovery unavailable'));
  expect(state.postMessage).toHaveBeenCalledWith({ event: 'reset' });
});
it('publishes client log changes without pruning again', async () => {
  vi.resetModules(); state.prune.mockClear(); state.start.mockClear();
  await import('./activityWorker');
  expect(state.prune).toHaveBeenCalledTimes(1);
  state.postMessage.mockClear();
  const [, changed] = state.start.mock.lastCall!;
  changed();
  expect(state.prune).toHaveBeenCalledTimes(1);
  expect(state.postMessage).toHaveBeenCalledExactlyOnceWith({ event: 'reset' });
});
