import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY } from '@shared/archive';
const mocks = vi.hoisted(() => ({ call: vi.fn(), lease: vi.fn(), captures: vi.fn(), ack: vi.fn(), clear: vi.fn() }));
vi.mock('./activityService', () => ({ activityLog: { call: mocks.call } }));
vi.mock('./managementClient', () => ({ management: { captureLease: mocks.lease, captures: mocks.captures, acknowledgeCaptures: mocks.ack, clearCaptures: mocks.clear } }));
import { ArchiveSync } from './archiveSync';

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.lease.mockResolvedValue(undefined); mocks.captures.mockResolvedValue({ version: 1, epoch: 'old', dropped: 0, records: [] }); });
afterEach(() => { vi.useRealTimers(); });
const status = (enabled = true) => ({ policy: { ...DEFAULT_ARCHIVE_POLICY, captureBodies: enabled }, epoch: 'old', sequence: 42 });
it('renews opt-in and resets the cursor on epoch change before durable ingest', async () => {
  mocks.call.mockResolvedValue(status());
  mocks.captures.mockResolvedValue({ version: 1, epoch: 'new', dropped: 0, records: [] });
  const sync = new ArchiveSync();
  await sync.start(); sync.stop();
  expect(mocks.lease).toHaveBeenCalledWith(true);
  expect(mocks.captures.mock.calls).toEqual([[42], [0]]);
  expect(mocks.call).toHaveBeenCalledWith('archiveIngest', expect.objectContaining({ epoch: 'new' }));
  expect(sync.error).toBeNull();
});
it('does not import legacy bodies when capture is disabled', async () => {
  mocks.call.mockResolvedValue(status(false));
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.lease).toHaveBeenCalledWith(false); expect(mocks.captures).toHaveBeenCalledOnce(); expect(mocks.call).not.toHaveBeenCalledWith('archiveIngest', expect.anything());
});
it('surfaces failed commits and retries from the durable cursor instead of skipping records', async () => {
  const page = { version: 1, epoch: 'old', dropped: 0, records: [{ sequence: 43 }] };
  mocks.call.mockImplementation((method: string) => method === 'archiveStatus' ? Promise.resolve(status()) : Promise.reject(new Error('disk unavailable')));
  mocks.captures.mockResolvedValue(page);
  const sync = new ArchiveSync(); await sync.start();
  expect(sync.error).toContain('disk unavailable');
  await vi.advanceTimersByTimeAsync(3_000); sync.stop();
  expect(mocks.captures.mock.calls).toEqual([[42], [42]]);
});
it('bounds each poll and stops rescheduling after a generation change', async () => {
  mocks.call.mockResolvedValue(status());
  mocks.captures.mockImplementation((cursor: number) => Promise.resolve({ version: 1, epoch: 'old', dropped: 0, records: [{ sequence: cursor + 1 }] }));
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.captures).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(60_000); expect(mocks.captures).toHaveBeenCalledTimes(4);
});
it('refreshing stored policy does not start a stopped proxy poller', async () => {
  const sync = new ArchiveSync(); await sync.refresh();
  expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.lease).not.toHaveBeenCalled();
});
it('sends a disabled lease once and drains full batches again promptly', async () => {
  mocks.call.mockResolvedValue(status(false));
  const sync = new ArchiveSync(); await sync.start();
  await vi.advanceTimersByTimeAsync(9_000); expect(mocks.lease).toHaveBeenCalledTimes(1); sync.stop();
  vi.clearAllMocks(); mocks.lease.mockResolvedValue(undefined); mocks.call.mockResolvedValue(status());
  mocks.captures.mockImplementation((cursor: number) => Promise.resolve({ version: 1, epoch: 'old', dropped: 0, records: mocks.captures.mock.calls.length <= 4 ? [1, 2, 3, 4].map((i) => ({ sequence: cursor + i })) : [] }));
  await sync.start(); expect(mocks.captures).toHaveBeenCalledTimes(4);
  const now = Date.now(); await vi.advanceTimersToNextTimerAsync(); expect(Date.now()).toBe(now); expect(mocks.captures).toHaveBeenCalledTimes(5); sync.stop();
});
it('acknowledges v2 pages only after their commit and retries an acknowledgement when the next page is empty', async () => {
  mocks.call.mockResolvedValue(status());
  mocks.captures.mockResolvedValue({ version: 2, epoch: 'old', dropped: 0, records: [] });
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.call).toHaveBeenCalledWith('archiveIngest', expect.anything());
  expect(mocks.ack).toHaveBeenCalledWith('old', 42);
  expect(mocks.ack.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.call.mock.invocationCallOrder.at(-1)!);
  mocks.call.mockImplementation((method: string) => method === 'archiveStatus' ? Promise.resolve(status()) : Promise.reject(new Error('commit failed')));
  mocks.ack.mockClear(); await sync.start(); sync.stop();
  expect(mocks.ack).not.toHaveBeenCalled(); expect(sync.error).toContain('commit failed');
});
it('drains retained v2 events after capture is turned off', async () => {
  mocks.call.mockResolvedValue(status(false));
  mocks.captures.mockResolvedValue({ version: 2, epoch: 'old', dropped: 0, records: [] });
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.lease).toHaveBeenCalledWith(false);
  expect(mocks.call).toHaveBeenCalledWith('archiveIngest', expect.anything()); expect(mocks.ack).toHaveBeenCalledWith('old', 42);
});
it('deletes local bodies immediately and acknowledges proxy deletion afterwards', async () => {
  mocks.call.mockResolvedValue(status(false));
  const sync = new ArchiveSync(); await sync.clear();
  expect(mocks.clear).toHaveBeenCalledOnce(); expect(mocks.call).toHaveBeenCalledWith('archiveClear');
  expect(mocks.call.mock.invocationCallOrder[0]).toBeLessThan(mocks.clear.mock.invocationCallOrder[0]!);
  expect(mocks.call).toHaveBeenLastCalledWith('archiveClearAcknowledged');
});
it('keeps local deletion when the proxy is offline and clears its journal before future ingestion', async () => {
  mocks.clear.mockRejectedValueOnce(new Error('offline'));
  const sync = new ArchiveSync();
  await expect(sync.clear()).rejects.toThrow('Local bodies deleted'); expect(mocks.call).toHaveBeenCalledWith('archiveClear');
  expect(mocks.call).not.toHaveBeenCalledWith('archiveClearAcknowledged');
  mocks.call.mockResolvedValue({ ...status(false), clearPending: true });
  mocks.captures.mockResolvedValue({ version: 2, epoch: 'old', dropped: 0, records: [] });
  await sync.start(); sync.stop();
  expect(mocks.call).toHaveBeenCalledWith('archiveClearAcknowledged');
  expect(mocks.clear.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.captures.mock.invocationCallOrder[0]!);
});

it('drains committed bytes while surfacing a producer storage warning', async () => {
  mocks.call.mockResolvedValue(status());
  mocks.captures.mockResolvedValue({ version: 2, epoch: 'old', dropped: 0, records: [], error: 'Capture storage write failed' });
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.ack).toHaveBeenCalledWith('old', 42);
  expect(sync.error).toBe('Capture storage write failed');
});
