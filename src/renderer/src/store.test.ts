import { describe, expect, it, vi } from 'vitest';
import { createComputed, createRoot } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import { emptyCounts } from '@shared/activityCounts';
import type { PriceCatalogState } from '@shared/modelPrices';
import type { ActivityBucket, ActivityBucketSnapshot, Credential, UsageSnapshot } from '@shared/types';

// IPC clones the request before main normalizes it.
const api = {
  setSettings: async (s: AppSettings) => normalizeSettings(structuredClone(s)),
  activityBucketSnapshot: vi.fn<(days: number | null) => Promise<ActivityBucketSnapshot>>().mockResolvedValue({ held: [], forecast: [] }),
};
vi.stubGlobal('window', { api, matchMedia: () => ({ matches: true, addEventListener: () => {} }) });
const { activityBuckets, forecastBuckets, holdActivityDays, history, initStore, logs, now, setHistory, setLogs, setNow, setSnapshot, settings, settingsError, shownText, snapshot, updateSettings } = await import('./store');
const { createPoolModel, poolRemaining } = await import('./components/poolModel');

const cred = (id: string, usedPercent: number): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false, canRefresh: true,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  weight: 1, plan: null, resetCredits: null,
  windows: [{ key: '5h', label: '5h', usedPercent, resetsAt: null, durationMs: null, status: null, scoped: false, resetCadence: null }],
});

describe('settings IPC serialization', () => {
  it('persists a placed chart when retained panel specs come from the reactive store', async () => {
    const board = settings().activity.board;
    const id = 'added-chart';
    const spec = { kind: 'accounts', metric: 'requests' } as const;
    const tiles = { kind: 'split', dir: 'column', sizes: [1, 1], children: [structuredClone(unwrap(board.tiles)), { kind: 'tile', id }] };
    const panels = { ...board.panels, [id]: spec };

    await updateSettings((draft) => { draft.activity.board = { version: board.version, tiles, panels, heightPx: board.heightPx }; });

    expect(settings().activity.board.tiles).toEqual(tiles);
    expect(settings().activity.board.panels).toEqual(panels);
    expect(settings().activity.board.panels[id]).toEqual(spec);
    expect(settingsError()).toBeNull();
  });
});

describe('failed settings saves', () => {
  it('resolve, keep the saved settings, and report why until a save succeeds', async () => {
    const before = settings().general.sidebarCollapsed;
    vi.spyOn(api, 'setSettings').mockRejectedValueOnce(new Error('disk full'));

    await expect(updateSettings((d) => { d.general.sidebarCollapsed = !before; })).resolves.toBeUndefined();
    expect(settings().general.sidebarCollapsed).toBe(before);
    expect(settingsError()).toBe('disk full');

    await updateSettings((d) => { d.general.sidebarCollapsed = !before; });
    expect(settings().general.sidebarCollapsed).toBe(!before);
    expect(settingsError()).toBeNull();
  });
});

it('masks displayed log text according to Show emails while preserving the raw diagnostic line', async () => {
  const previous = logs();
  const showEmails = settings().dashboard.showEmails;
  const text = 'auth file changed: claude-person@example.com.json';
  setLogs([{ at: '2026-11-03T12:00:00Z', stream: 'stdout', text }]);
  try {
    await updateSettings((d) => { d.dashboard.showEmails = false; });
    expect(shownText(logs()[0]!.text)).toBe('auth file changed: •••@example.com.json');
    await updateSettings((d) => { d.dashboard.showEmails = true; });
    expect(shownText(logs()[0]!.text)).toBe(text);
    expect(logs()[0]!.text).toBe(text);
  } finally {
    setLogs(previous);
    await updateSettings((d) => { d.dashboard.showEmails = showEmails; });
  }
});
const snap = (...credentials: Credential[]): UsageSnapshot => ({ fetchedAt: '', strategy: 'round-robin', credentials });

function mockActivityEvents() {
  let live = () => {};
  let reset = () => {};
  let price = (_state: PriceCatalogState) => {};
  const catalog: PriceCatalogState = { prices: {}, info: { fetchedAt: null, models: 0 } };
  const subscribe = () => () => {};
  Object.assign(api, {
    onOpenSettings: subscribe, onOpenProxy: subscribe, onActivityImport: subscribe, onArchiveMigration: subscribe,
    priceCatalog: async () => catalog,
    archiveMigrationState: async () => ({ state: 'idle', done: 0, total: 0 }),
    activityImportState: async () => ({ state: 'idle', filesDone: 0, filesTotal: 0, recordsImported: 0, error: null }),
    getSettings: async () => structuredClone(unwrap(settings())), usageLatest: async () => ({ snapshot: null, error: null }),
    proxyStatus: async () => null, usageHistory: async () => [], usageWindowSummaries: async () => [], usageObservedSpans: async () => [],
    proxyLogs: async () => [], taskbarDark: async () => true,
    onSnapshot: subscribe, onUsageError: subscribe, onProxyStatus: subscribe, onProxyLog: subscribe,
    onMaximized: subscribe, onTaskbarDark: subscribe, onSettings: subscribe,
    onActivity: (cb: () => void) => { live = cb; return () => {}; },
    onActivityReset: (cb: () => void) => { reset = cb; return () => {}; },
    onPriceCatalog: (cb: (state: PriceCatalogState) => void) => { price = cb; return () => {}; },
  });
  return { live: () => live(), reset: () => reset(), price: () => price(catalog) };
}

const bucketSnapshot = (start: number): ActivityBucketSnapshot => ({ held: [{ start } as ActivityBucket], forecast: [{ start } as ActivityBucket] });

describe('forecast activity evidence', () => {
  it('keeps pool capacity and forecasts fixed when the Activity page widens or narrows', async () => {
    const bucket: ActivityBucket = {
      ...emptyCounts(), start: 0, wholeDay: false, provider: 'claude', authIndex: 'a', model: 'm', client: null,
      requests: 1, inputTokens: 1, outputTokens: 1, costUsd: 1, uncachedCostUsd: 1,
    };
    const forecast = [bucket, { ...bucket, authIndex: 'b', costUsd: 3 }];
    const credentials = [cred('a', 20), cred('b', 80)];
    for (const c of credentials) c.windows[0]!.durationMs = 5 * 3_600_000;
    const previousHistory = history();
    const previousNow = now();
    setHistory([
      { at: new Date(0).toISOString(), used: { a: { '5h': 0 }, b: { '5h': 0 } } },
      { at: new Date(3_600_000).toISOString(), used: { a: { '5h': 50 }, b: { '5h': 50 } } },
    ]);
    setNow(3_600_000);
    try {
      let expectedProjection: ReturnType<ReturnType<typeof createPoolModel>['projection']> | undefined;
      for (const days of [90, null, 31]) {
        const pageBuckets = [{ ...bucket, costUsd: days ?? 1000 }, { ...bucket, authIndex: 'b' }];
        api.activityBucketSnapshot.mockResolvedValueOnce({ held: pageBuckets, forecast });
        holdActivityDays(days);
        await Promise.resolve();
        expect(api.activityBucketSnapshot).toHaveBeenLastCalledWith(days);
        expect(activityBuckets()).toEqual(pageBuckets);
        expect(forecastBuckets()).toEqual(forecast);
        createRoot((dispose) => {
          const model = createPoolModel(() => ({ provider: 'claude', credentials }), () => '5h', () => 'round-robin');
          expect(poolRemaining(credentials, '5h')).toBeCloseTo(35);
          expect(model.summary()!.remaining).toBeCloseTo(35);
          expectedProjection ??= model.projection();
          expect(model.projection()).toEqual(expectedProjection);
          dispose();
        });
      }
    } finally {
      setHistory(previousHistory);
      setNow(previousNow);
    }
  });

  it('applies both ranges together and ignores older responses after a range change', async () => {
    let resolveOld!: (value: ActivityBucketSnapshot) => void;
    let resolveNew!: (value: ActivityBucketSnapshot) => void;
    api.activityBucketSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveNew = resolve; }));
    holdActivityDays(90);
    holdActivityDays(null);
    const latest = { held: [{ start: 1 } as ActivityBucket], forecast: [{ start: 2 } as ActivityBucket] };
    const observed: [ActivityBucket[], ActivityBucket[]][] = [];
    let dispose!: () => void;
    createRoot((stop) => { dispose = stop; createComputed(() => { observed.push([activityBuckets(), forecastBuckets()]); }); });
    try {
      resolveNew(latest);
      await Promise.resolve();
      expect(observed.slice(1)).toEqual([[latest.held, latest.forecast]]);
      resolveOld({ held: [], forecast: [] });
      await Promise.resolve();
      expect(activityBuckets()).toEqual(latest.held);
      expect(forecastBuckets()).toEqual(latest.forecast);
      expect(observed).toHaveLength(2);
    } finally { dispose(); holdActivityDays(31); await Promise.resolve(); }
  });

  it('advances slow live reads, ignores out-of-order replies and invalidates pre-reset snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T14:00:00Z'));
    const { live, reset } = mockActivityEvents();
    const replies: ((value: ActivityBucketSnapshot) => void)[] = [];
    const value = bucketSnapshot;
    const poll = async () => { live(); await vi.advanceTimersByTimeAsync(2_000); };
    try {
      await initStore();
      api.activityBucketSnapshot.mockImplementation(() => new Promise((resolve) => { replies.push(resolve); }));
      await poll(); await poll();
      replies[0]!(value(1));
      await Promise.resolve();
      expect(activityBuckets()).toEqual(value(1).held);
      replies[1]!(value(2));
      await Promise.resolve();
      expect(activityBuckets()).toEqual(value(2).held);
      await poll(); await poll();
      replies[3]!(value(4));
      await Promise.resolve();
      replies[2]!(value(3));
      await Promise.resolve();
      expect(activityBuckets()).toEqual(value(4).held);
      await poll();
      reset();
      replies[4]!(value(5));
      await Promise.resolve();
      expect(activityBuckets()).toEqual(value(4).held);
      replies[5]!(value(6));
      await Promise.resolve();
      expect(activityBuckets()).toEqual(value(6).held);
      expect(forecastBuckets()).toEqual(value(6).forecast);
    } finally {
      api.activityBucketSnapshot.mockReset().mockResolvedValue({ held: [], forecast: [] });
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it('keeps the forecast reference on live polls and refreshes it on reset, repricing and hour rollover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T14:58:00Z'));
    const { live, reset, price } = mockActivityEvents();
    const previousNow = now();
    const startup = bucketSnapshot(1);
    const next = bucketSnapshot(2);
    api.activityBucketSnapshot.mockResolvedValueOnce(startup).mockResolvedValueOnce(next);
    try {
      await initStore();
      expect(forecastBuckets()).toBe(startup.forecast);
      live();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(activityBuckets()).toBe(next.held);
      expect(forecastBuckets()).toBe(startup.forecast);

      const afterReset = bucketSnapshot(3);
      api.activityBucketSnapshot.mockResolvedValueOnce(afterReset);
      reset();
      await Promise.resolve();
      expect(forecastBuckets()).toBe(afterReset.forecast);

      const afterPrice = bucketSnapshot(4);
      api.activityBucketSnapshot.mockResolvedValueOnce(afterPrice);
      price();
      await Promise.resolve();
      expect(forecastBuckets()).toBe(afterPrice.forecast);

      await vi.advanceTimersByTimeAsync(117_000);
      expect(forecastBuckets()).toBe(afterPrice.forecast);
      let resolveRollover!: (value: ActivityBucketSnapshot) => void;
      const afterRollover = bucketSnapshot(5);
      api.activityBucketSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveRollover = resolve; })).mockResolvedValueOnce(afterRollover);
      live();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(forecastBuckets()).toBe(afterPrice.forecast);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(activityBuckets()).toBe(afterRollover.held);
      expect(forecastBuckets()).toBe(afterRollover.forecast);
      resolveRollover(bucketSnapshot(6));
      await Promise.resolve();
      expect(forecastBuckets()).toBe(afterRollover.forecast);
    } finally {
      setNow(previousNow);
      api.activityBucketSnapshot.mockReset().mockResolvedValue({ held: [], forecast: [] });
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it('distinguishes null plans from empty-tier plans in the shared poolShares cache', () => {
    const previousHistory = history();
    const withWeekly = (id: string, used5h: number, used7d: number, plan: Credential['plan']): Credential => ({
      ...cred(id, used5h),
      plan,
      windows: [
        { key: '5h', label: '5h', usedPercent: used5h, resetsAt: null, durationMs: 5 * 3_600_000, status: null, scoped: false, resetCadence: null },
        { key: '7d', label: '7d', usedPercent: used7d, resetsAt: null, durationMs: 168 * 3_600_000, status: null, scoped: false, resetCadence: null },
      ],
    });
    setHistory([
      { at: new Date(0).toISOString(), used: { a: { '5h': 0, '7d': 0 }, b: { '5h': 0, '7d': 0 } } },
      { at: new Date(3_600_000).toISOString(), used: { a: { '5h': 20, '7d': 10 }, b: { '5h': 40, '7d': 10 } } },
    ]);
    try {
      const a = withWeekly('a', 0, 0, { tier: '', label: 'Custom', multiplier: null });
      const b = withWeekly('b', 0, 0, { tier: 'pro', label: 'Pro', multiplier: 1 });
      const cNull = withWeekly('c', 0, 100, null);
      const cEmptyTier = withWeekly('c', 0, 100, { tier: '', label: 'Custom', multiplier: null });
      // cNull borrows the mean ratio (3) across a (2) and b (4); cEmptyTier borrows same-tier a's ratio (2).
      expect(poolRemaining([a, b, cNull], '7d')).toBeCloseTo(600 / 9);
      expect(poolRemaining([a, b, cEmptyTier], '7d')).toBeCloseTo(600 / 8);
    } finally {
      setHistory(previousHistory);
    }
  });

  it('keeps an in-flight rollover forecast pending when an earlier live reply arrives first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T14:59:57Z'));
    const { live } = mockActivityEvents();
    const previousNow = now();
    const startup = bucketSnapshot(1);
    const liveSnap = bucketSnapshot(2);
    const rolloverSnap = bucketSnapshot(3);
    let resolveLive!: (value: ActivityBucketSnapshot) => void;
    let resolveRollover!: (value: ActivityBucketSnapshot) => void;
    api.activityBucketSnapshot
      .mockResolvedValueOnce(startup)
      .mockReturnValueOnce(new Promise((resolve) => { resolveLive = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveRollover = resolve; }));
    try {
      await initStore();
      live();
      await vi.advanceTimersByTimeAsync(2_000); // 14:59:59: sends pre-rollover live request
      await vi.advanceTimersByTimeAsync(1_000); // 15:00:00: sends rollover forecast request
      const callsAtRollover = api.activityBucketSnapshot.mock.calls.length;
      resolveLive(liveSnap);
      await Promise.resolve();
      expect(activityBuckets()).toBe(liveSnap.held);
      expect(forecastBuckets()).toBe(startup.forecast);
      await vi.advanceTimersByTimeAsync(60_000); // 15:01:00: must not issue duplicate rollover request
      expect(api.activityBucketSnapshot).toHaveBeenCalledTimes(callsAtRollover);
      resolveRollover(rolloverSnap);
      await Promise.resolve();
      expect(forecastBuckets()).toBe(rolloverSnap.forecast);
    } finally {
      setNow(previousNow);
      api.activityBucketSnapshot.mockReset().mockResolvedValue({ held: [], forecast: [] });
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });
});

// Keyed lists (<For>) keep a row, and its local state, only while its item keeps its identity.
describe('store keeps object identity across updates', () => {
  it('snapshot: each credential survives a poll, even reordered', () => {
    setSnapshot(snap(cred('a', 10), cred('b', 20)));
    const [a, b] = snapshot()!.credentials;
    setSnapshot(snap(cred('b', 25), cred('a', 10)));
    const [first, second] = snapshot()!.credentials;
    expect(first).toBe(b);
    expect(second).toBe(a);
    expect(first?.windows[0]?.usedPercent).toBe(25);
  });

  it('settings: tray items survive a save that edits one of them', async () => {
    const before = [...settings().trayIcons.items];
    expect(before.length).toBeGreaterThan(1);
    await updateSettings((d) => void (d.trayIcons.items[0]!.look = { ...d.trayIcons.items[0]!.look, color: '#123456' }));
    const after = settings().trayIcons.items;
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[0]?.look.color).toBe('#123456');
  });
});
