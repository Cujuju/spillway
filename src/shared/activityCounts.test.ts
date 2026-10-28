import { describe, expect, it } from 'vitest';
import { addEvent, emptyCounts, withCountsFilled } from './activityCounts';
import type { ActivityEvent } from './types';

const event = (patch: Partial<ActivityEvent>): ActivityEvent => ({
  at: '2026-10-26T12:00:00Z', requestId: 'r', selectionId: null, provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 1, ttftMs: null,
  inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, sessionId: null, movedFrom: null, userAgent: null, client: null, ...patch,
});

describe('activity counts', () => {
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
});
