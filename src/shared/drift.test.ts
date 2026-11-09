import { expect, it } from 'vitest';
import { driftPoints, driftValue, type DriftDay } from './drift';
import { normalizeCanary, CANARY_MAX_TARGETS } from './canary';
import { normalizeSettings } from './settings';
import { diffRequestSettings, parseRequestSettings } from './requestSettings';
const day = (value: number, replies = 30): DriftDay => ({ day: '2026-11-08', replies, failed: 0, outputTokens: value * replies, thinkingTokens: value * replies, thinkingKnown: replies, noThinking: 0, ttftSumMs: 0, ttftCount: 0, latencySumMs: 0, latencyCount: 0 });
it('requires samples and a prior baseline, flags shifts and handles zero spread', () => {
  expect(driftValue(day(10, 29), 'outputPerReply')).toBeNull();
  const p = driftPoints([...Array.from({ length: 5 }, () => day(10)), day(100)], 'outputPerReply');
  expect(p[4]?.baseline).toBeNull(); expect(p[5]).toMatchObject({ baseline: 10, flagged: 'up', z: 9 });
  expect(driftPoints(Array.from({ length: 6 }, () => day(0)), 'outputPerReply')[5]?.z).toBe(0);
});
it('canonicalizes settings and describes differences', () => {
  const s = parseRequestSettings({ thinking: { type: 'adaptive' }, max_tokens: 128000, betas: ['z', 'a', 'a'] })!;
  expect(s.betas).toEqual(['a', 'z']); expect(parseRequestSettings({ messages: [] })).toBeNull();
  expect(diffRequestSettings(parseRequestSettings({ max_tokens: 64000 }), s)).toContain('max tokens 64,000 → 128,000');
});
it('normalizes canary defaults, intervals, target cap and app settings', () => {
  expect(normalizeSettings({}).canary).toEqual({ enabled: false, intervalHours: 24, targets: [] });
  const raw = { enabled: true, intervalHours: 7, targets: Array.from({ length: 8 }, (_, i) => ({ model: `m${i}`, effort: 'high' })) };
  expect(normalizeCanary(raw).targets).toHaveLength(CANARY_MAX_TARGETS); expect(normalizeSettings({ canary: raw }).canary.intervalHours).toBe(24);
});

it('applies the spread floor to tiny nonzero baseline deviations', () => {
  const points = driftPoints([9.99, 10, 10.01, 10.02, 9.98, 10.1].map((v) => day(v)), 'outputPerReply');
  expect(points[5]).toMatchObject({ baseline: 10, flagged: null });
  expect(points[5]?.z).toBeCloseTo(0.01);
});

it.each(['thinkingPerReply', 'outputPerReply', 'noThinkingRate', 'failureRate', 'meanTtftMs'] as const)('flags large shifts from zero for %s', (metric) => {
  const baseline = Array.from({ length: 5 }, () => ({ ...day(0), ttftCount: 30 }));
  const jump = { ...day(100), failed: 30, noThinking: 30, ttftSumMs: 30_000, ttftCount: 30 };
  expect(driftPoints([...baseline, jump], metric)[5]?.flagged).toBe('up');
});
it('does not flag one failure in thirty after a zero failure baseline', () => {
  const days = [...Array.from({ length: 5 }, () => day(0)), { ...day(0, 29), failed: 1 }];
  expect(driftPoints(days, 'failureRate')[5]?.flagged).toBeNull();
});
