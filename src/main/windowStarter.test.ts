import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import type { Credential, UsageSnapshot } from '@shared/types';

let settings: AppSettings;
let snapshot: UsageSnapshot;
const events = new EventEmitter();
const startWindow = vi.fn<(authIndex: string, model: string) => Promise<UsageSnapshot>>();
vi.mock('./settingsStore', () => ({ getSettings: () => settings }));
vi.mock('./usagePoller', () => ({ usage: { on: events.on.bind(events), latest: () => snapshot, startWindow } }));
vi.mock('./managementClient', () => ({ ManagementError: class extends Error {}, management: {} }));

let starter: (typeof import('./windowStarter'))['windowStarter'];
const credential = (id: string): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  weight: 1, plan: null, resetCredits: null,
  windows: [{ key: 'five_hour', label: '5-hour', usedPercent: 0, resetsAt: null, durationMs: 5 * 3_600_000, status: 'allowed', scoped: false, resetCadence: 'on_use' }],
});
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  events.removeAllListeners();
  startWindow.mockReset();
  settings = normalizeSettings({ windowStart: { enabled: true, stagger: false, models: { claude: 'initial-model' } } });
  snapshot = { fetchedAt: new Date().toISOString(), strategy: 'soonest-reset', credentials: ['a', 'b', 'c'].map(credential) };
  startWindow.mockResolvedValue(snapshot);
  ({ windowStarter: starter } = await import('./windowStarter'));
  starter.attach();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(['disabled', 'outside active hours'])('does not send queued starts after settings become %s', async (change) => {
  let release!: (s: UsageSnapshot) => void;
  startWindow.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  events.emit('snapshot', snapshot);
  await vi.waitFor(() => expect(startWindow).toHaveBeenCalledOnce());
  const minute = new Date().getHours() * 60 + new Date().getMinutes();
  const windowStart = change === 'disabled' ? { ...settings.windowStart, enabled: false } : {
    ...settings.windowStart, activeHours: { enabled: true, startMinute: (minute + 60) % 1440, endMinute: (minute + 120) % 1440 },
  };
  settings = normalizeSettings({ ...settings, windowStart });
  release(snapshot);
  await vi.waitFor(() => expect(starter.status().lastStart?.credentialId).toBe('a'));
  expect(startWindow).toHaveBeenCalledOnce();
});

it('uses current model settings for subsequent accounts', async () => {
  let release!: (s: UsageSnapshot) => void;
  startWindow.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  events.emit('snapshot', snapshot);
  await vi.waitFor(() => expect(startWindow).toHaveBeenCalledOnce());
  settings = normalizeSettings({ ...settings, windowStart: { ...settings.windowStart, models: { ...settings.windowStart.models, claude: 'updated-model' } } });
  release(snapshot);
  await vi.waitFor(() => expect(startWindow).toHaveBeenCalledTimes(3));
  expect(startWindow.mock.calls).toEqual([['a', 'initial-model'], ['b', 'updated-model'], ['c', 'updated-model']]);
});
