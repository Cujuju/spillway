import { expect, it } from 'vitest';
import { mergeHistory, type TransferHistory } from './historyMerge';
import type { WindowSummary } from '@shared/types';

const now = Date.parse('2026-10-31T12:00:00Z');
const at = (offset: number) => new Date(now + offset).toISOString();
const empty: TransferHistory = { samples: [], summaries: [], observed: [] };
const summary: WindowSummary = { credentialId: 'a', key: 'weekly', resetAt: now, firstSampleAt: now - 10, lastSampleAt: now - 5, peak: 100, endedAt: null, exhaustedAt: null };
it('unions samples in time order, merges equal timestamps and trims retention', () => {
  const old = '2020-01-01T00:00:00Z';
  const a: TransferHistory = { ...empty, samples: [{ at: old, used: {} }, { at: at(0), used: { a: { weekly: 30 } }, resets: { a: { weekly: 10 } } }] };
  const b: TransferHistory = { ...empty, samples: [{ at: at(0), used: { a: { weekly: 20 }, b: { daily: 40 } }, resets: { a: { weekly: 20 } } }, { at: at(-1), used: {} }] };
  const result = mergeHistory(a, b, now);
  expect(result.samples).toEqual([{ at: at(-1), used: {} }, { at: at(0), used: { a: { weekly: 30 }, b: { daily: 40 } }, resets: { a: { weekly: 20 } } }]);
  expect(mergeHistory(b, a, now)).toEqual(result);
  expect(mergeHistory(result, result, now)).toEqual(result);
});
it('coalesces overlapping and touching spans only for the same account and key', () => {
  const span = { credentialId: 'a', key: 'weekly', from: now - 10, to: now - 5 };
  const a: TransferHistory = { ...empty, observed: [span, { ...span, key: 'daily' }, { ...span, from: 0, to: 1 }] };
  const b: TransferHistory = { ...empty, observed: [{ ...span, from: now - 5, to: now }, { ...span, from: now - 8, to: now - 6 }, { ...span, credentialId: 'b' }, { ...span, from: now + 1, to: now + 2 }] };
  const result = mergeHistory(a, b, now);
  expect(result.observed).toHaveLength(4);
  expect(result.observed).toContainEqual({ ...span, to: now });
  expect(mergeHistory(b, a, now)).toEqual(result);
  expect(mergeHistory(result, result, now)).toEqual(result);
});
it('combines duplicate windows using extrema and earliest defined ending and exhaustion', () => {
  const a: TransferHistory = { ...empty, summaries: [summary, { ...summary, key: 'daily', endedAt: now - 2 }] };
  const b: TransferHistory = { ...empty, summaries: [{ ...summary, firstSampleAt: now - 20, lastSampleAt: now - 1, peak: 110, endedAt: now - 3, exhaustedAt: now - 4 }, { ...summary, key: 'daily', endedAt: now - 4 }] };
  const result = mergeHistory(a, b, now);
  expect(result.summaries[0]).toEqual({ ...summary, firstSampleAt: now - 20, lastSampleAt: now - 1, peak: 110, endedAt: now - 3, exhaustedAt: now - 4 });
  expect(result.summaries.find((s) => s.key === 'daily')?.endedAt).toBe(now - 4);
  expect(mergeHistory(b, a, now)).toEqual(result);
  expect(mergeHistory(result, result, now)).toEqual(result);
});
it('keeps separate resets and prunes summaries by the existing retention semantics', () => {
  const a: TransferHistory = { ...empty, summaries: [summary, { ...summary, resetAt: 0 }, { ...summary, peak: 0, resetAt: now - 1 }] };
  const b: TransferHistory = { ...empty, summaries: [{ ...summary, resetAt: now + 1 }] };
  expect(mergeHistory(a, b, now).summaries.map((s) => s.resetAt)).toEqual([now, now + 1]);
});
