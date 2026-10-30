import { describe, expect, it } from 'vitest';
import { emptyCounts } from '@shared/activityCounts';
import type { ActivityBucket } from '@shared/types';
import { bucketStarts, rangeSpan } from './activityRange';
import { byAccount, byModel, series, summarize } from './activityStats';

// Local-clock times so bucket edges don't depend on the test machine's zone.
const NOW = new Date(2026, 9, 26, 14, 30).getTime();
const at = (daysAgo: number, hour: number) => new Date(2026, 9, 26 - daysAgo, hour).getTime();
const row = (start: number, patch: Partial<ActivityBucket> = {}): ActivityBucket => ({
  ...emptyCounts(), start, wholeDay: false, provider: 'claude', authIndex: 'a', model: 'claude-opus-5-5', client: null, requests: 1, ...patch,
});

describe('series / summarize', () => {
  it('puts each row in its bucket and drops rows before the range', () => {
    const starts = bucketStarts(rangeSpan('24h', NOW, { from: '', to: '' }, null), 'hour');
    const points = series([row(at(0, 13)), row(at(0, 13)), row(at(0, 14)), row(at(3, 9))], starts, NOW);
    expect(points.at(-2)!.summary.requests).toBe(2);
    expect(points.at(-1)!.summary.requests).toBe(1);
    expect(points.reduce((n, p) => n + p.summary.requests, 0)).toBe(3);
  });
  it('rates cache hits over all prompt tokens, by each provider\'s rules', () => {
    const s = summarize([
      row(NOW, { inputTokens: 10, cachedTokens: 80, cacheWriteTokens: 10 }),
      row(NOW, { provider: 'codex', model: 'gpt-6.1-sol', inputTokens: 100, cachedTokens: 50 }),
    ]);
    expect(s.promptTokens).toBe(200);
    expect(s.cacheHitRate).toBeCloseTo(130 / 200);
  });
});

describe('byModel', () => {
  it('groups by provider and model, costliest first', () => {
    const models = byModel([row(NOW, { model: 'a', costUsd: 1 }), row(NOW, { model: 'b', costUsd: 3 }), row(NOW, { model: 'a', costUsd: 1 })]);
    expect(models.map((m) => [m.model, m.summary.requests])).toEqual([['b', 1], ['a', 2]]);
  });
});

describe('byAccount', () => {
  it('groups by account across models, costliest first, keeping requests without one', () => {
    const accounts = byAccount([
      row(NOW, { authIndex: 'a', model: 'x', costUsd: 1 }), row(NOW, { authIndex: 'b', costUsd: 5 }),
      row(NOW, { authIndex: 'a', model: 'y', costUsd: 1 }), row(NOW, { authIndex: null, costUsd: 0.5 }),
    ]);
    expect(accounts.map((a) => [a.authIndex, a.summary.requests])).toEqual([['b', 1], ['a', 2], [null, 1]]);
  });
});
