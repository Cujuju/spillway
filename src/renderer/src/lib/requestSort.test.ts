import { describe, expect, it } from 'vitest';
import type { StoredActivityEvent } from '@shared/types';
import { DEFAULT_SORT, isRecordedOrder, isRequestSort, nextSort, sortRequests } from './requestSort';

const row = (id: number, patch: Partial<StoredActivityEvent> = {}): StoredActivityEvent => ({
  id, at: new Date(2026, 9, 27, 12, 0, id).toISOString(), requestId: `r${id}`, selectionId: null, provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a1',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 100, ttftMs: 10, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0,
  ...patch,
});
const account = (a: string | null) => a ?? '';
const ids = (rows: StoredActivityEvent[]) => rows.map((r) => r.id);

describe('sortRequests', () => {
  const rows = [row(1, { ttftMs: 50 }), row(2, { ttftMs: null }), row(3, { ttftMs: 20 }), row(4, { ttftMs: 50 })];
  it('puts rows without a value last in both directions, ties newest first', () => {
    expect(ids(sortRequests(rows, { key: 'firstToken', desc: true }, account))).toEqual([4, 1, 3, 2]);
    expect(ids(sortRequests(rows, { key: 'firstToken', desc: false }, account))).toEqual([3, 4, 1, 2]);
  });
  it('sorts unpriced requests last by cost', () => {
    const priced = [row(1, { outputTokens: 1 }), row(2, { model: 'unknown-model' }), row(3, { outputTokens: 1000 })];
    expect(ids(sortRequests(priced, { key: 'cost', desc: false }, account))).toEqual([1, 3, 2]);
  });
  it('sorts accounts by name', () => {
    const named = [row(1, { authIndex: 'b' }), row(2, { authIndex: 'a' })];
    expect(ids(sortRequests(named, { key: 'account', desc: false }, account))).toEqual([2, 1]);
  });
});

describe('nextSort', () => {
  it('flips the sorted column and starts others at their natural direction', () => {
    expect(nextSort(DEFAULT_SORT, 'time')).toEqual({ key: 'time', desc: false });
    expect(nextSort(DEFAULT_SORT, 'cost')).toEqual({ key: 'cost', desc: true });
    expect(nextSort(DEFAULT_SORT, 'account')).toEqual({ key: 'account', desc: false });
  });
  it('pages from the database only in recorded order', () => {
    expect(isRecordedOrder(DEFAULT_SORT)).toBe(true);
    expect(isRecordedOrder({ key: 'time', desc: false })).toBe(false);
  });
  it('rejects stored sorts for unknown columns', () => {
    expect(isRequestSort({ key: 'gone', desc: true })).toBe(false);
    expect(isRequestSort({ key: 'cost', desc: false })).toBe(true);
  });
});
