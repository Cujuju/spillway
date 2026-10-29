import { describe, expect, it, vi } from 'vitest';
import { unwrap } from 'solid-js/store';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import type { Credential, UsageSnapshot } from '@shared/types';

// IPC clones the request before main normalizes it.
const api = { setSettings: async (s: AppSettings) => normalizeSettings(structuredClone(s)) };
vi.stubGlobal('window', { api, matchMedia: () => ({ matches: true, addEventListener: () => {} }) });
const { setSnapshot, settings, settingsError, snapshot, updateSettings } = await import('./store');

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

    await updateSettings((draft) => { draft.activity.board = { tiles, panels }; });

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
