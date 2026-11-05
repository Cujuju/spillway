import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY } from '@shared/archive';
const mocks = vi.hoisted(() => ({ call: vi.fn(), lease: vi.fn(), captures: vi.fn() }));
vi.mock('./activityService', () => ({ activityLog: { call: mocks.call } }));
vi.mock('./managementClient', () => ({ management: { captureLease: mocks.lease, captures: mocks.captures } }));
import { ArchiveSync } from './archiveSync';

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.lease.mockResolvedValue(undefined); });
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
it('does not drain bodies when capture is disabled', async () => {
  mocks.call.mockResolvedValue(status(false));
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.lease).toHaveBeenCalledWith(false); expect(mocks.captures).not.toHaveBeenCalled();
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
  mocks.captures.mockImplementation((cursor: number) => Promise.resolve({ version: 1, epoch: 'old', dropped: 0, records: [1, 2, 3, 4].map((i) => ({ sequence: cursor + i })) }));
  await sync.start(); expect(mocks.captures).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(50); expect(mocks.captures).toHaveBeenCalledTimes(8); sync.stop();
});
