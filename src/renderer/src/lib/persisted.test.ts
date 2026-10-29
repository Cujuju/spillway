import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HEAT_MODES, type HeatMode } from './activityStats';
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

  it('restores the legacy week heat mode and keeps tile choices independent', () => {
    const modes = HEAT_MODES.map((m) => m.value);
    store.set('spillway.view.activity.heatMode.first', JSON.stringify('week'));
    const [first] = persistedSignal<HeatMode>('activity.heatMode.first', 'hourly', modes);
    const [second, setSecond] = persistedSignal<HeatMode>('activity.heatMode.second', 'week', modes);
    expect(first()).toBe('week');
    expect(HEAT_MODES.find((m) => m.value === first())!.label).toBe('7 days');
    setSecond('lastWeek');
    expect(second()).toBe('lastWeek');
    expect(first()).toBe('week');
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
