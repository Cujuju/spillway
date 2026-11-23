import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityScope } from '@shared/activityScope';
import type { ActivityDaySummary, StoredActivityEvent } from '@shared/types';

const activityDaySummaries = vi.fn<(scope: ActivityScope) => Promise<ActivityDaySummary[]>>();
vi.stubGlobal('window', {
  api: {
    activityDaySummaries,
    onActivity: () => () => {},
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
