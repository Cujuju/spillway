import { createComputed, createRoot, createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActivityScope } from '@shared/activityScope';
import type { Credential, UsageSnapshot } from '@shared/types';
import type { Span } from './activityRange';

const emptySnap = (count = 0): UsageSnapshot => ({
  fetchedAt: '', strategy: 'round-robin', credentials: Array.from({ length: count }, () => ({}) as Credential),
});

vi.mock('../store', () => {
  const [liveActivityVersion, setLiveActivityVersion] = createSignal(0);
  const [snapshot, setSnapshot] = createSignal<UsageSnapshot | null>({ fetchedAt: '', strategy: 'round-robin', credentials: [] });
  return { liveActivityVersion, setLiveActivityVersion, snapshot, setSnapshot };
});
const { setLiveActivityVersion, setSnapshot } = await import('../store');
const { createReportQuery, REPORT_REFRESH_MS } = await import('./reportRefresh');
const { createCompareReport } = await import('./compareReport');
const { createWasteReport } = await import('./wasteReport');
const { createThinkingReport } = await import('./thinkingReport');

const api = {
  activityCompare: vi.fn().mockResolvedValue(null),
  activityWaste: vi.fn().mockResolvedValue(null),
  activityThinking: vi.fn().mockResolvedValue(null),
};

function setupDoc() {
  vi.useFakeTimers();
  vi.stubGlobal('window', { api });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', doc);
  const show = (visible: boolean) => { doc.hidden = !visible; doc.dispatchEvent(new Event('visibilitychange')); };
  const traffic = () => setLiveActivityVersion((version) => version + 1);
  return { show, traffic };
}

afterEach(() => {
  api.activityCompare.mockClear();
  api.activityWaste.mockClear();
  api.activityThinking.mockClear();
  setSnapshot(emptySnap());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('coalesces live traffic at most once per interval, stays idle without changes, and cancels pending timers on param change', () => {
  const { traffic } = setupDoc();
  let dispose!: () => void;
  const emissions: number[] = [];
  let setRange!: (r: string) => void;
  let clock = 1000;
  createRoot((stop) => {
    dispose = stop;
    const [active] = createSignal(true);
    const [range, _setRange] = createSignal('7d');
    setRange = _setRange;
    const query = createReportQuery(active, () => range(), () => ++clock);
    createComputed(() => { const q = query(); if (q !== false) emissions.push(q); });
  });
  try {
    expect(emissions).toHaveLength(1);
    vi.advanceTimersByTime(REPORT_REFRESH_MS);
    expect(emissions).toHaveLength(1);

    traffic();
    vi.advanceTimersByTime(0);
    expect(emissions).toHaveLength(2);

    // Live traffic schedules a 60s timer; a param change 10s later emits immediately and cancels the timer.
    traffic();
    vi.advanceTimersByTime(10_000);
    expect(emissions).toHaveLength(2);
    setRange('30d');
    expect(emissions).toHaveLength(3);
    vi.advanceTimersByTime(REPORT_REFRESH_MS - 1);
    expect(emissions).toHaveLength(3);

    // New traffic after the param change still waits the full interval from the param fetch.
    traffic();
    vi.advanceTimersByTime(1);
    expect(emissions).toHaveLength(4);
  } finally { dispose(); }
});

it('gates compare, waste, and thinking IPC calls across minute ticks, resets, visibility changes, and range switches', async () => {
  const { show, traffic } = setupDoc();
  vi.setSystemTime(1_700_000_000_000);
  const baseScope: ActivityScope = { accounts: null, clients: null, source: 'all', efforts: null };
  let dispose!: () => void;
  let setNowMs!: (n: number) => void;
  let setRangeKey!: (k: string) => void;
  let setScope!: (s: ActivityScope) => void;
  let setTab!: (t: 'overview' | 'waste' | 'thinking' | 'requests') => void;
  let thinkingQuery!: ReturnType<typeof createThinkingReport>['query'];
  createRoot((stop) => {
    dispose = stop;
    const [tab, _setTab] = createSignal<'overview' | 'waste' | 'thinking' | 'requests'>('overview');
    const [nowMs, _setNowMs] = createSignal(1_700_000_000_000);
    const [rangeKey, _setRangeKey] = createSignal('7d');
    const [scope, _setScope] = createSignal<ActivityScope>(baseScope);
    setTab = _setTab; setNowMs = _setNowMs; setRangeKey = _setRangeKey; setScope = _setScope;
    // Matches Activity.tsx: reports read current wall-clock Date.now() at emit time, independent of minute-tick now().
    const currentSpan = (): Span => ({ from: Date.now() - 7 * 86_400_000, to: Date.now() });
    // Ensure a reactive minute-tick signal changing cannot cause report refetches on its own.
    createComputed(() => nowMs());
    createCompareReport(() => tab() === 'overview', scope, currentSpan, rangeKey);
    createWasteReport(() => tab() === 'waste', scope, currentSpan, () => rangeKey() === 'all', rangeKey);
    thinkingQuery = createThinkingReport(() => tab() === 'thinking', scope, currentSpan, rangeKey).query;
  });
  try {
    await Promise.resolve();
    expect(api.activityCompare).toHaveBeenCalledTimes(1);
    expect(api.activityWaste).not.toHaveBeenCalled();
    expect(api.activityThinking).not.toHaveBeenCalled();

    // Wall-clock minute ticks alone must NOT refetch any report.
    setNowMs(1_700_000_060_000);
    vi.advanceTimersByTime(60_000);
    setNowMs(1_700_000_120_000);
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(api.activityCompare).toHaveBeenCalledTimes(1);

    // A request 10s after the last minute tick emits with the exact wall-clock Date.now() so it is not excluded.
    vi.advanceTimersByTime(10_000);
    traffic();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    expect(api.activityCompare).toHaveBeenCalledTimes(2);
    expect(api.activityCompare).toHaveBeenLastCalledWith({ scope: baseScope, from: 1_700_000_130_000 - 7 * 86_400_000, to: 1_700_000_130_000 });

    // Traffic-only reveal within 60s preserves the throttle deadline instead of emitting early.
    show(false);
    vi.advanceTimersByTime(20_000);
    traffic();
    show(true);
    await Promise.resolve();
    expect(api.activityCompare).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(39_999);
    expect(api.activityCompare).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(api.activityCompare).toHaveBeenCalledTimes(3);

    // Hidden: minute ticks, traffic/resets, scope changes, and credential changes all defer with zero IPC.
    show(false);
    setNowMs(1_700_000_250_000);
    traffic();
    setScope({ ...baseScope, source: 'proxy' });
    setSnapshot(emptySnap(1));
    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(api.activityCompare).toHaveBeenCalledTimes(3);

    // Reveal emits immediately when user/structural params changed while hidden.
    show(true);
    await Promise.resolve();
    expect(api.activityCompare).toHaveBeenCalledTimes(4);
    expect(api.activityCompare).toHaveBeenLastCalledWith({ scope: { ...baseScope, source: 'proxy' }, from: 1_700_000_200_000 - 7 * 86_400_000, to: 1_700_000_200_000 });

    // Switching tabs activates waste and thinking with the same visibility and throttle contract.
    setTab('waste');
    await Promise.resolve();
    expect(api.activityWaste).toHaveBeenCalledTimes(1);
    show(false);
    traffic();
    vi.advanceTimersByTime(REPORT_REFRESH_MS);
    expect(api.activityWaste).toHaveBeenCalledTimes(1);
    show(true);
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    expect(api.activityWaste).toHaveBeenCalledTimes(2);

    const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
    setTab('thinking');
    await flush();
    expect(api.activityThinking).toHaveBeenCalledTimes(1);
    const firstThinkingQuery = api.activityThinking.mock.lastCall?.[0];
    expect(thinkingQuery()).toEqual(firstThinkingQuery);

    // During an in-flight Thinking refresh, thinkingQuery stays paired with the previous resolved report.
    let resolveNextThinking!: (v: null) => void;
    api.activityThinking.mockReturnValueOnce(new Promise((resolve) => { resolveNextThinking = resolve; }));
    vi.advanceTimersByTime(15_000);
    setRangeKey('30d');
    await flush();
    expect(api.activityThinking).toHaveBeenCalledTimes(2);
    const secondThinkingQuery = api.activityThinking.mock.lastCall?.[0];
    expect(secondThinkingQuery).not.toEqual(firstThinkingQuery);
    expect(thinkingQuery()).toEqual(firstThinkingQuery);
    resolveNextThinking(null);
    await flush();
    expect(thinkingQuery()).toEqual(secondThinkingQuery);
  } finally { dispose(); }
});
