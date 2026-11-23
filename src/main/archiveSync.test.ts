import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY } from '@shared/archive';
const mocks = vi.hoisted(() => ({ call: vi.fn(), lease: vi.fn(), captures: vi.fn(), ack: vi.fn(), clear: vi.fn() }));
vi.mock('./activityService', () => ({ activityLog: { call: mocks.call } }));
vi.mock('./managementClient', () => ({ management: { captureLease: mocks.lease, captures: mocks.captures, acknowledgeCaptures: mocks.ack, clearCaptures: mocks.clear } }));
import { ArchiveSync, type ArchiveSyncAlert } from './archiveSync';

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
  expect(mocks.call).toHaveBeenCalledWith('archiveIngestBatch', [expect.objectContaining({ epoch: 'new' })]);
  expect(sync.error).toBeNull();
});
it('does not import legacy bodies when capture is disabled', async () => {
  mocks.call.mockResolvedValue(status(false));
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.lease).toHaveBeenCalledWith(false); expect(mocks.captures).toHaveBeenCalledOnce(); expect(mocks.call).not.toHaveBeenCalledWith('archiveIngestBatch', expect.anything());
});
it('surfaces failed commits and retries from the durable cursor instead of skipping records', async () => {
  const page = { version: 1, epoch: 'old', dropped: 0, records: [{ sequence: 43 }] };
  mocks.call.mockImplementation((method: string) => method === 'archiveStatus' ? Promise.resolve(status()) : Promise.reject(new Error('disk unavailable')));
  mocks.captures.mockResolvedValue(page);
  const alerts: ArchiveSyncAlert[] = [];
  const sync = new ArchiveSync(); sync.on('alert', (a: ArchiveSyncAlert) => alerts.push(a));
  await sync.start();
  expect(sync.error).toContain('disk unavailable');
  expect(alerts).toEqual([{ kind: 'error', message: 'disk unavailable' }]);
  await vi.advanceTimersByTimeAsync(3_000); sync.stop();
  expect(mocks.captures.mock.calls).toEqual([[42], [42]]);
  expect(alerts).toHaveLength(1);
});
it('bounds each poll batch and stops rescheduling after a generation change', async () => {
  mocks.call.mockResolvedValue(status());
  mocks.captures.mockImplementation((cursor: number) => Promise.resolve({
    version: 2, epoch: 'old', dropped: 0,
    records: [1, 2, 3, 4].map((i) => ({ sequence: cursor + i, startedAt: new Date().toISOString() })),
  }));
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.captures).toHaveBeenCalledTimes(16);
  expect(mocks.call).toHaveBeenCalledWith('archiveIngestBatch', expect.any(Array));
  expect(mocks.ack).toHaveBeenCalledOnce();
  expect(mocks.ack).toHaveBeenCalledWith('old', 42 + 64);
  await vi.advanceTimersByTimeAsync(60_000); expect(mocks.captures).toHaveBeenCalledTimes(16);
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
  mocks.captures.mockImplementation((cursor: number) => Promise.resolve({
    version: 1, epoch: 'old', dropped: 0,
    records: mocks.captures.mock.calls.length <= 16 ? [1, 2, 3, 4].map((i) => ({ sequence: cursor + i })) : [],
  }));
  await sync.start(); expect(mocks.captures).toHaveBeenCalledTimes(16);
  const now = Date.now(); await vi.advanceTimersToNextTimerAsync(); expect(Date.now()).toBe(now); expect(mocks.captures).toHaveBeenCalledTimes(17); sync.stop();
});
it('acknowledges v2 pages only after their commit and retries an acknowledgement when the next page is empty', async () => {
  mocks.call.mockResolvedValue(status());
  mocks.captures.mockResolvedValue({ version: 2, epoch: 'old', dropped: 0, records: [] });
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.call).toHaveBeenCalledWith('archiveIngestBatch', [expect.anything()]);
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
  expect(mocks.call).toHaveBeenCalledWith('archiveIngestBatch', [expect.anything()]); expect(mocks.ack).toHaveBeenCalledWith('old', 42);
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
it('alerts once only when full-batch draining persists past the lag threshold, ignoring old stream startedAt bursts', async () => {
  const oldStreamStart = new Date(Date.now() - 15 * 60_000).toISOString();
  mocks.call.mockResolvedValue(status());
  let calls = 0;
  mocks.captures.mockImplementation((cursor: number) => {
    calls++;
    if (calls <= 48) {
      return Promise.resolve({
        version: 2, epoch: 'old', dropped: 0,
        records: [1, 2, 3, 4].map((i) => ({ sequence: cursor + i, startedAt: oldStreamStart })),
      });
    }
    return Promise.resolve({ version: 2, epoch: 'old', dropped: 0, records: [] });
  });
  const alerts: ArchiveSyncAlert[] = [];
  const sync = new ArchiveSync(); sync.on('alert', (a: ArchiveSyncAlert) => alerts.push(a));
  await sync.start();
  expect(sync.lagAt).toBeNull();
  expect(alerts).toEqual([]);
  // A failed poll resets the continuous-drain clock so an outage gap cannot trigger a spurious lag alert.
  mocks.captures.mockRejectedValueOnce(new Error('transient'));
  vi.setSystemTime(Date.now() + 5 * 60_000);
  await vi.advanceTimersToNextTimerAsync();
  expect(sync.error).toBe('transient');
  expect(sync.lagAt).toBeNull();
  const restartedDrainAt = new Date(Date.now() + 3_000).toISOString();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(sync.lagAt).toBeNull();
  vi.setSystemTime(Date.now() + 5 * 60_000);
  await vi.advanceTimersToNextTimerAsync();
  expect(sync.lagAt).toBe(restartedDrainAt);
  expect(alerts).toEqual([{ kind: 'error', message: 'transient' }, { kind: 'lag', message: restartedDrainAt }]);
  await vi.advanceTimersToNextTimerAsync();
  expect(sync.lagAt).toBeNull();
  expect(alerts).toHaveLength(2);
  sync.stop();
});
it('commits the prior epoch batch without sending a doomed ACK on mid-batch epoch rotation', async () => {
  mocks.call.mockResolvedValue(status());
  let calls = 0;
  mocks.captures.mockImplementation((cursor: number) => {
    calls++;
    if (calls === 1) return Promise.resolve({ version: 2, epoch: 'old', dropped: 0, records: [1, 2, 3, 4].map((i) => ({ sequence: cursor + i })) });
    if (calls === 2) return Promise.resolve({ version: 2, epoch: 'mid', dropped: 0, records: [] });
    return Promise.resolve({ version: 2, epoch: 'new', dropped: 0, records: [{ sequence: 1 }] });
  });
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.ack).toHaveBeenCalledOnce();
  expect(mocks.ack).toHaveBeenCalledWith('new', 1);
  expect(sync.error).toBeNull();
});
it('clears lag state on stop and ignores late errors from a superseded poll generation', async () => {
  mocks.call.mockResolvedValue(status());
  let rejectStale: ((err: Error) => void) | undefined;
  mocks.captures.mockImplementationOnce(() => new Promise((_, reject) => { rejectStale = reject; }));
  const sync = new ArchiveSync();
  const stale = sync.start();
  await vi.waitFor(() => expect(rejectStale).toBeDefined());
  mocks.captures.mockResolvedValueOnce({ version: 2, epoch: 'old', dropped: 0, records: [] });
  await sync.start();
  rejectStale!(new Error('stale failure'));
  await stale;
  expect(sync.error).toBeNull();
  sync.lagAt = new Date().toISOString();
  sync.stop();
  expect(sync.lagAt).toBeNull();
});
it('commits and ACKs a fetched batch prefix when a later page fetch fails', async () => {
  mocks.call.mockResolvedValue(status());
  mocks.captures
    .mockResolvedValueOnce({ version: 2, epoch: 'old', dropped: 0, records: [43, 44, 45, 46].map((sequence) => ({ sequence })) })
    .mockRejectedValueOnce(new Error('mid-batch fetch failed'));
  const sync = new ArchiveSync(); await sync.start(); sync.stop();
  expect(mocks.call).toHaveBeenCalledWith('archiveIngestBatch', [expect.objectContaining({ epoch: 'old' })]);
  expect(mocks.ack).toHaveBeenCalledWith('old', 46);
  expect(sync.error).toBe('mid-batch fetch failed');
});
it('does not let a superseded refresh clear a restarted poll error', async () => {
  mocks.call.mockResolvedValue(status());
  let resolveOld!: (v: unknown) => void;
  mocks.captures.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
  const sync = new ArchiveSync();
  void sync.start();
  await vi.waitFor(() => expect(resolveOld).toBeDefined());
  const refreshing = sync.refresh();
  mocks.captures.mockRejectedValueOnce(new Error('restarted failure'));
  await sync.start();
  resolveOld({ version: 2, epoch: 'old', dropped: 0, records: [] });
  await refreshing;
  expect(sync.error).toBe('restarted failure');
  sync.stop();
});
