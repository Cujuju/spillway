import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import type { ActivityBucket, Credential, UsageSnapshot } from '@shared/types';
import { RHYTHM_LOOKBACK_DAYS } from './lib/rhythmProfile';

// IPC clones the request before main normalizes it.
const api = {
  setSettings: async (s: AppSettings) => normalizeSettings(structuredClone(s)),
  activityBuckets: vi.fn<(days: number | null) => Promise<ActivityBucket[]>>().mockResolvedValue([]),
};
vi.stubGlobal('window', { api, matchMedia: () => ({ matches: true, addEventListener: () => {} }) });
const { activityBuckets, forecastBuckets, holdActivityDays, history, now, setHistory, setNow, setSnapshot, settings, settingsError, snapshot, updateSettings } = await import('./store');
const { createPoolModel, poolRemaining } = await import('./components/poolModel');

const cred = (id: string, usedPercent: number): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
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

    await updateSettings((draft) => { draft.activity.board = { tiles, panels, heightPx: null }; });

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
const snap = (...credentials: Credential[]): UsageSnapshot => ({ fetchedAt: '', strategy: 'round-robin', credentials });

describe('forecast activity evidence', () => {
  it('keeps pool capacity and forecasts fixed when the Activity page widens or narrows', async () => {
    const bucket: ActivityBucket = {
      start: 0, wholeDay: false, provider: 'claude', authIndex: 'a', model: 'm', client: null,
      requests: 1, failed: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0,
      costUsd: 1, uncachedCostUsd: 1, unpricedRequests: 0,
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
        api.activityBuckets.mockResolvedValueOnce(pageBuckets).mockResolvedValueOnce(forecast);
        holdActivityDays(days);
        await Promise.resolve();
        expect(api.activityBuckets).toHaveBeenNthCalledWith(api.activityBuckets.mock.calls.length - 1, days);
        expect(api.activityBuckets).toHaveBeenLastCalledWith(RHYTHM_LOOKBACK_DAYS);
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
