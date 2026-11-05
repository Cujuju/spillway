import { describe, expect, it } from 'vitest';
import { addCounts, addEvent, emptyCounts, withCountsFilled } from './activityCounts';
import type { ActivityEvent } from './types';

const event = (patch: Partial<ActivityEvent>): ActivityEvent => ({
  at: '2026-10-26T12:00:00Z', requestId: 'r', selectionId: null, upstreamId: null, source: 'proxy', provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 1, ttftMs: null,
  inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, sessionId: null, movedFrom: null, userAgent: null, client: null, ...patch,
});

describe('activity counts', () => {
  it.each(['account-a', null])('sums metadata-bearing rows without changing their identities (%s)', (authIndex) => {
    const metadata = { provider: 'claude', authIndex, model: 'claude-opus-5-5', day: '2026-10-26', source: 'proxy' };
    const row = { ...metadata, ...emptyCounts() };
    const counts = { ...metadata, ...emptyCounts(), requests: 2, costUsd: 3 };
    addCounts(row, counts);
    addCounts(row, counts);
    expect(row).toEqual({ ...metadata, ...emptyCounts(), requests: 4, costUsd: 6 });
    const total = emptyCounts();
    addCounts(total, counts);
    expect(total).toEqual({ ...emptyCounts(), requests: 2, costUsd: 3 });
  });
  it('sums cost for priced models and counts the rest as unpriced', () => {
    const row = emptyCounts();
    addEvent(row, event({}));
    addEvent(row, event({ model: 'mystery' }));
    expect(row).toMatchObject({ requests: 2, unpricedRequests: 1 });
    expect(row.costUsd).toBeCloseTo(4);
  });
  it('prices rows saved before cost was recorded', () => {
    const row = withCountsFilled({ provider: 'claude', model: 'claude-opus-5-5', requests: 3, failed: 0, inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 });
    expect(row.cacheWriteTokens).toBe(0);
    expect(row.costUsd).toBeCloseTo(4);
    expect(withCountsFilled({ provider: 'x', model: 'y', requests: 3 }).unpricedRequests).toBe(3);
  });

  it('prices effective models and counts only measured timings, preserving sums through merges', () => {
    const c = emptyCounts();
    addEvent(c, event({ model: 'coding', effectiveModel: 'claude-opus-5-5', latencyMs: 100, ttftMs: 20 }));
    addEvent(c, event({ model: 'coding', effectiveModel: 'claude-opus-5-5', latencyMs: 900, ttftMs: null }));
    addEvent(c, event({ source: 'client-log', latencyMs: 0, ttftMs: null }));
    addEvent(c, event({ latencyMs: null, ttftMs: null }));
    addEvent(c, event({ failed: true, latencyMs: 5, ttftMs: 2 }));
    expect(c).toMatchObject({ requests: 5, failed: 1, latencyCount: 2, latencySumMs: 1000, ttftCount: 1, ttftSumMs: 20, unpricedRequests: 0 });
    expect(c.costUsd).toBeCloseTo(20);
    const merged = emptyCounts();
    addCounts(merged, c);
    expect(merged).toEqual(c);
    expect(withCountsFilled({ provider: 'x', model: 'y', requests: 9 })).toMatchObject({ latencyCount: 0, latencySumMs: 0 });
  });
});
