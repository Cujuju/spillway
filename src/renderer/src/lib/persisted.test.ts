import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isString, persistedSignal } from './persisted';

const store = new Map<string, string>();
const TABS = ['a', 'b'] as const;

describe('persistedSignal', () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  it('restores what an earlier instance stored', () => {
    const [, setTab] = persistedSignal<(typeof TABS)[number]>('tab', 'a', TABS);
    setTab('b');
    const [tab] = persistedSignal<(typeof TABS)[number]>('tab', 'a', TABS);
    expect(tab()).toBe('b');
  });

  it('falls back to the initial value for a rejected or corrupt entry', () => {
    store.set('spillway.view.tab', JSON.stringify('removed-option'));
    expect(persistedSignal('tab', 'a', TABS)[0]()).toBe('a');
    store.set('spillway.view.query', '{not json');
    expect(persistedSignal('query', '', isString)[0]()).toBe('');
  });

  it('stores the result of an updater function', () => {
    const [, setCount] = persistedSignal('count', 1, (v): v is number => typeof v === 'number');
    setCount((n) => n + 1);
    expect(store.get('spillway.view.count')).toBe('2');
  });

  it('keeps working in memory when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('unavailable'); },
      setItem: () => { throw new Error('full'); },
    });
    const [query, setQuery] = persistedSignal('query', '', isString);
    setQuery('x');
    expect(query()).toBe('x');
  });
});
