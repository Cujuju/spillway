import { describe, expect, it, vi } from 'vitest';
import { createMemo, createRoot, createSignal } from 'solid-js';
import type { StoredActivityEvent } from '@shared/types';
import { createRequestOrder, DEFAULT_SORT, isRecordedOrder, isRequestSort, nextSort, sortRequests, type RequestSort } from './requestSort';

const row = (id: number, patch: Partial<StoredActivityEvent> = {}): StoredActivityEvent => ({
  id, at: new Date(2026, 9, 27, 12, 0, id).toISOString(), requestId: `r${id}`, selectionId: null, upstreamId: null, source: 'proxy', provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a1',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 100, ttftMs: 10, inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0, sessionId: null, movedFrom: null, userAgent: null, client: null,
  ...patch,
});
const labels = { account: (a: string | null) => a ?? '', conversation: (id: string | null) => id ?? '' };
const ids = (rows: StoredActivityEvent[]) => rows.map((r) => r.id);

// Tests inspect current memo values synchronously.
/* oxlint-disable solid/reactivity */
it('reuses the sorted day across reveal and loading changes, but updates for rows, sort and labels', () => createRoot((dispose) => {
  const [section, setSection] = createSignal({ rows: [row(1, { authIndex: 'a' }), row(2, { authIndex: 'b' })], shown: 1, loading: false });
  const [sort, setSort] = createSignal<RequestSort>({ key: 'account', desc: false });
  const [names, setNames] = createSignal<Record<string, string>>({ a: 'Alpha', b: 'Beta' });
  const account = vi.fn((id: string | null) => names()[id ?? ''] ?? '');
  const ordered = createRequestOrder(() => section().rows, sort, { ...labels, account });
  const visible = createMemo(() => ordered().slice(0, section().shown));
  expect(ids(visible())).toEqual([1]);
  const calls = account.mock.calls.length;
  setSection((s) => ({ ...s, shown: 2, loading: true }));
  expect(ids(visible())).toEqual([1, 2]);
  expect(account).toHaveBeenCalledTimes(calls);
  setNames({ a: 'Zulu', b: 'Beta' });
  expect(ids(visible())).toEqual([2, 1]);
  setSection((s) => ({ ...s, rows: [row(3, { authIndex: 'b' }), ...s.rows] }));
  expect(ids(visible())).toEqual([3, 2]);
  setSort({ key: 'account', desc: true });
  expect(ids(visible())).toEqual([1, 3]);
  setSort(DEFAULT_SORT);
  expect(ordered()).toBe(section().rows);
  setSection((s) => ({ ...s, rows: s.rows.filter((r) => r.id !== 1) }));
  expect(ids(visible())).toEqual([3, 2]);
  dispose();
}));

it('refreshes conversation ordering for renamed labels while preserving nulls and ties', () => createRoot((dispose) => {
  const rows = [row(1, { sessionId: 'a' }), row(2), row(3, { sessionId: 'b' }), row(4, { sessionId: 'b' })];
  const [names, setNames] = createSignal<Record<string, string>>({ a: 'Alpha', b: 'Beta' });
  const [sort, setSort] = createSignal<RequestSort>({ key: 'conversation', desc: false });
  const dynamicLabels = { ...labels, conversation: (id: string | null) => names()[id ?? ''] ?? '' };
  const ordered = createRequestOrder(() => rows, sort, dynamicLabels);
  expect(ids(ordered())).toEqual([1, 4, 3, 2]);
  setNames({ a: 'Zulu', b: 'Beta' });
  expect(ids(ordered())).toEqual([4, 3, 1, 2]);
  setSort({ key: 'conversation', desc: true });
  expect(ordered()).toEqual(sortRequests(rows, sort(), dynamicLabels));
  expect(ids(ordered())).toEqual([1, 4, 3, 2]);
  dispose();
}));

/* oxlint-enable solid/reactivity */

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

