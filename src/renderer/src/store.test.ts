import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/settings';
import type { Credential, UsageSnapshot } from '@shared/types';

// Echoes the saved settings back, as main does after normalizing.
const api = { setSettings: async (s: AppSettings) => s };
vi.stubGlobal('window', { api, matchMedia: () => ({ matches: true, addEventListener: () => {} }) });
const { setSnapshot, settings, snapshot, updateSettings } = await import('./store');

const cred = (id: string, usedPercent: number): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  weight: 1, plan: null, resetCredits: null,
  windows: [{ key: '5h', label: '5h', usedPercent, resetsAt: null, durationMs: null, status: null, scoped: false, resetCadence: null }],
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
