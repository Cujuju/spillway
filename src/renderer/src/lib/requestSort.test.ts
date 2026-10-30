import { describe, expect, it } from 'vitest';
import type { StoredActivityEvent } from '@shared/types';
import { DEFAULT_SORT, isRecordedOrder, isRequestSort, nextSort, sortRequests } from './requestSort';

const row = (id: number, patch: Partial<StoredActivityEvent> = {}): StoredActivityEvent => ({
  id, at: new Date(2026, 9, 27, 12, 0, id).toISOString(), requestId: `r${id}`, selectionId: null, upstreamId: null, source: 'proxy', provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a1',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 100, ttftMs: 10, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0, sessionId: null, movedFrom: null, userAgent: null, client: null,
  ...patch,
});
const labels = { account: (a: string | null) => a ?? '', conversation: (id: string | null) => id ?? '' };
const ids = (rows: StoredActivityEvent[]) => rows.map((r) => r.id);

describe('sortRequests', () => {
  const rows = [row(1, { ttftMs: 50 }), row(2, { ttftMs: null }), row(3, { ttftMs: 20 }), row(4, { ttftMs: 50 })];
  it('puts rows without a value last in both directions, ties newest first', () => {
    expect(ids(sortRequests(rows, { key: 'firstToken', desc: true }, labels))).toEqual([4, 1, 3, 2]);
    expect(ids(sortRequests(rows, { key: 'firstToken', desc: false }, labels))).toEqual([3, 4, 1, 2]);
  });
  it('sorts unpriced requests last by cost', () => {
    const priced = [row(1, { outputTokens: 1 }), row(2, { model: 'unknown-model' }), row(3, { outputTokens: 1000 })];
    expect(ids(sortRequests(priced, { key: 'cost', desc: false }, labels))).toEqual([1, 3, 2]);
  });
  it('sorts accounts by name', () => {
    const named = [row(1, { authIndex: 'b' }), row(2, { authIndex: 'a' })];
    expect(ids(sortRequests(named, { key: 'account', desc: false }, labels))).toEqual([2, 1]);
  });
});

describe('nextSort', () => {
  it('steps a column through ascending, descending, then the default', () => {
    const up = nextSort(DEFAULT_SORT, 'cost');
    expect(up).toEqual({ key: 'cost', desc: false });
    const down = nextSort(up, 'cost');
    expect(down).toEqual({ key: 'cost', desc: true });
    expect(nextSort(down, 'cost')).toEqual(DEFAULT_SORT);
  });
  it('starts another column ascending', () => {
    expect(nextSort({ key: 'cost', desc: true }, 'account')).toEqual({ key: 'account', desc: false });
  });
  it('flips Time between oldest first and the default', () => {
    expect(nextSort(DEFAULT_SORT, 'time')).toEqual({ key: 'time', desc: false });
    expect(nextSort({ key: 'time', desc: false }, 'time')).toEqual(DEFAULT_SORT);
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

describe('conversation column', () => {
  it('sorts by conversation label, requests without one last', () => {
    const rows = [row(1, { sessionId: 'claude:b' }), row(2, { sessionId: null }), row(3, { sessionId: 'claude:a' })];
    expect(ids(sortRequests(rows, { key: 'conversation', desc: false }, labels))).toEqual([3, 1, 2]);
    expect(ids(sortRequests(rows, { key: 'conversation', desc: true }, labels))).toEqual([1, 3, 2]);
  });
});

