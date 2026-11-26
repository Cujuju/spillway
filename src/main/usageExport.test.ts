import { beforeEach, expect, it, vi } from 'vitest';
import type { HistorySample, ObservedSpan, WindowSummary } from '@shared/types';

const call = vi.hoisted(() => vi.fn());
const history = vi.hoisted(() => ({ all: vi.fn(), summaries: vi.fn(), observed: vi.fn() }));
vi.mock('./activityService', () => ({ activityLog: { call } }));
vi.mock('./historyStore', () => ({ history }));

beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });

it.each([[false, true], [true, false]])('skips polls and clears once on refresh with export %s and usage %s', async (enabled, usage) => {
  call.mockResolvedValueOnce({ config: { enabled, stores: { usage } } }).mockResolvedValue(undefined);
  const { exportUsage } = await import('./usageExport');
  exportUsage(false);
  expect(call).not.toHaveBeenCalled();

  exportUsage(true);
  await Promise.resolve();
  exportUsage(false);
  exportUsage(false);
  expect(call.mock.calls).toEqual([['clickhouseStatus'], ['clickhouseMirrorUsage', [], expect.any(String)]]);
  expect(history.all).not.toHaveBeenCalled();
  expect(history.summaries).not.toHaveBeenCalled();
  expect(history.observed).not.toHaveBeenCalled();
});

it('mirrors the full history on enable and only the latest sample alongside summaries and spans on a poll', async () => {
  const older: HistorySample = { at: '2026-11-25T13:00:00Z', used: { a: { '5h': 10 } } };
  const latest: HistorySample = { at: '2026-11-25T14:00:00Z', used: { a: { '5h': 20 } } };
  const from = Date.parse(older.at), to = Date.parse(latest.at);
  const summary: WindowSummary = { credentialId: 'a', key: '5h', firstSampleAt: from, lastSampleAt: to, resetAt: to, endedAt: null, peak: 20, exhaustedAt: null };
  const span: ObservedSpan = { credentialId: 'a', key: '5h', from, to };
  history.all.mockReturnValue([older, latest]);
  history.summaries.mockReturnValue([summary]);
  history.observed.mockReturnValue([span]);
  call.mockResolvedValueOnce({ config: { enabled: true, stores: { usage: true } } }).mockResolvedValue(undefined);
  const { exportUsage } = await import('./usageExport');
  exportUsage(true);
  await Promise.resolve();
  exportUsage(false);
  const mirrored = call.mock.calls.slice(1).map(([, records]) => records.map(({ record }: { record: string }) => JSON.parse(record)));
  expect(mirrored).toEqual([[older, latest, summary, span], [latest, summary, span]]);
});

it('recovers after a failed status read on the next poll and ignores stale overlapping refreshes', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const sample: HistorySample = { at: '2026-11-25T14:00:00Z', used: { a: { '5h': 20 } } };
    history.all.mockReturnValue([sample]);
    history.summaries.mockReturnValue([]);
    history.observed.mockReturnValue([]);

    call.mockRejectedValueOnce(new Error('worker restarting'))
      .mockResolvedValueOnce({ config: { enabled: true, stores: { usage: true } } })
      .mockResolvedValueOnce(undefined);
    const { exportUsage } = await import('./usageExport');
    exportUsage(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(err).toHaveBeenCalledTimes(1);

    // Next poll retries status refresh and recovers full export.
    exportUsage(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(call.mock.calls.map(([m]) => m)).toEqual(['clickhouseStatus', 'clickhouseStatus', 'clickhouseMirrorUsage']);
    expect(call.mock.calls[2]![1]).toHaveLength(1);

    // Overlapping refreshes: older resolution/rejection must not overwrite the newer refresh.
    call.mockClear();
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    call.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }))
      .mockResolvedValue(undefined);
    exportUsage(true);
    exportUsage(true);
    resolveSecond({ config: { enabled: false, stores: { usage: false } } });
    await Promise.resolve();
    resolveFirst({ config: { enabled: true, stores: { usage: true } } });
    await Promise.resolve();
    call.mockClear();
    exportUsage(false);
    expect(call).not.toHaveBeenCalled();
  } finally { err.mockRestore(); }
});
