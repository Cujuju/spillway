import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityScope } from '@shared/activityScope';
import type { ActivityDaySummary, StoredActivityEvent } from '@shared/types';

const activityDaySummaries = vi.fn<(scope: ActivityScope) => Promise<ActivityDaySummary[]>>();
let onActivity = (_e: StoredActivityEvent) => {};
let onReset = () => {};
vi.stubGlobal('window', {
  api: {
    activityDaySummaries,
    onActivity: (cb: (e: StoredActivityEvent) => void) => { onActivity = cb; return () => {}; },
    onActivityReset: (cb: () => void) => { onReset = cb; return () => {}; },
  },
});

const { createDaySummaries } = await import('./daySummaries');
const { mergeRefreshedRows, reconcileRows, refreshedShownCount } = await import('./requestRows');

const row = (id: number, patch: Partial<StoredActivityEvent> = {}): StoredActivityEvent => ({
  id, at: '2026-11-23T12:00:00Z', requestId: `r-${id}`, selectionId: null, upstreamId: null,
  source: 'client-log', provider: 'antigravity', model: 'gemini-4-neon', authIndex: null,
  stream: true, failed: false, statusCode: null, error: null, latencyMs: null, ttftMs: null,
  inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0,
  sessionId: 'agy:s1', movedFrom: null, userAgent: null, client: 'antigravity-acp',
  ...patch,
});

describe('createDaySummaries', () => {
  it('defers loading while inactive, loads on activation, and drops stale responses after deactivation', async () => {
    let resolveLoad!: (rows: ActivityDaySummary[]) => void;
    activityDaySummaries.mockImplementation(() => new Promise((resolve) => { resolveLoad = resolve; }));

    await new Promise<void>((done) => {
      createRoot((dispose) => {
        const [active, setActive] = createSignal(false);
        const [scope] = createSignal<ActivityScope>({ accounts: null, clients: null, source: 'all' });
        const days = createDaySummaries(active, scope);
        queueMicrotask(() => {
          expect(activityDaySummaries).not.toHaveBeenCalled();
          setActive(true);
          queueMicrotask(() => {
            expect(activityDaySummaries).toHaveBeenCalledTimes(1);
            setActive(false);
            resolveLoad([{ day: '2026-11-23', requests: 5, failed: 0, costUsd: 1, unpricedRequests: 0, newestId: 5 }]);
            queueMicrotask(() => {
              expect(days.list()).toEqual([]);
              dispose();
              done();
            });
          });
        });
      });
    });
  });

  it('defers reset reloads while hidden, exposes resetCount on reveal, and drops stale old-scope replies', async () => {
    const doc = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', doc);
    let resolveOld!: (rows: ActivityDaySummary[]) => void;
    activityDaySummaries.mockClear()
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue([]);
    let dispose!: () => void;
    let days!: ReturnType<typeof createDaySummaries>;
    let setScope!: (s: ActivityScope) => void;
    try {
      createRoot((stop) => {
        dispose = stop;
        const [active] = createSignal(true);
        const [scope, _setScope] = createSignal<ActivityScope>({ accounts: null, clients: null, source: 'all' });
        setScope = _setScope;
        days = createDaySummaries(active, scope);
      });
      await Promise.resolve();
      expect(activityDaySummaries).toHaveBeenCalledTimes(1);
      expect(days.resetCount()).toBe(0);

      // Hiding + scope change drops the in-flight old-scope response without issuing IPC while hidden.
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      setScope({ accounts: null, clients: null, source: 'proxy' });
      onReset();
      resolveOld([{ day: '2026-11-23', requests: 9, failed: 0, costUsd: 1, unpricedRequests: 0, newestId: 9 }]);
      await Promise.resolve();
      expect(activityDaySummaries).toHaveBeenCalledTimes(1);
      expect(days.list()).toEqual([]);
      expect(days.resetCount()).toBe(0);

      doc.hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      expect(activityDaySummaries).toHaveBeenCalledTimes(2);
      expect(days.resetCount()).toBe(1);

      // Ordinary hidden live traffic reloads summaries on reveal without bumping resetCount for open day sections.
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      onActivity(row(10));
      await Promise.resolve();
      expect(activityDaySummaries).toHaveBeenCalledTimes(2);
      doc.hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      expect(activityDaySummaries).toHaveBeenCalledTimes(3);
      expect(days.resetCount()).toBe(1);
    } finally {
      dispose?.();
      vi.stubGlobal('document', undefined);
    }
  });
});

describe('ActivityRequests refresh helpers', () => {
  it('preserves object identity for unchanged rows and replaces updated rows by ID', () => {
    const first = row(2);
    const second = row(1);
    const reconciled = reconcileRows([first, second], [row(2), row(1, { authIndex: 'cred-1' })]);
    expect(reconciled[0]).toBe(first);
    expect(reconciled[1]).not.toBe(second);
    expect(reconciled[1]?.authIndex).toBe('cred-1');
  });

  it('merges live events buffered during refresh ahead of fetched rows without duplicating IDs', () => {
    const fetched = [row(3), row(2)];
    const buffered = [row(3), row(4), row(5)];
    expect(mergeRefreshedRows(fetched, buffered).map((e) => e.id)).toEqual([5, 4, 3, 2]);
  });

  it('keeps every surviving previously visible row revealed across dropped boundaries and sort reorders', () => {
    const prior = [row(4), row(3), row(2), row(1)];
    // Row 2 (the previous 3rd boundary row) drops out while rows 6 and 5 arrive ahead of surviving rows 4 and 3.
    const droppedBoundary = [row(6), row(5), row(4), row(3), row(1)];
    expect(refreshedShownCount(prior, 3, droppedBoundary, 2)).toBe(4);
    // Under a custom sort, row 1 moves ahead of row 2, pushing previously visible row 2 to index 3 (4th row).
    const reordered = [row(1), row(4), row(3), row(2)];
    expect(refreshedShownCount(prior, 3, reordered, 2)).toBe(4);
  });
});
