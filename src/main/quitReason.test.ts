import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QuitReasonAddon } from './quitReason';

const settings = vi.hoisted(() => ({ confirmQuit: true }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', focus: vi.fn(), quit: vi.fn() }, dialog: {} }));
vi.mock('./settingsStore', () => ({ getSettings: () => ({ general: settings }) }));

const realPlatform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value });

type Event = ReturnType<QuitReasonAddon['takeQuit']>;
/** A stand-in for the native addon: install() succeeds unless told otherwise, takeQuit() hands out each queued event once. */
function fakeAddon(events: Event[], installs = true) {
  return { install: vi.fn(() => installs), takeQuit: vi.fn(() => events.shift() ?? null) };
}

beforeEach(() => {
  vi.resetModules();
  setPlatform('darwin');
  settings.confirmQuit = true;
});
afterEach(() => setPlatform(realPlatform));

it('loads the addon from the repo in dev and reports each fresh quit event once', async () => {
  const { watchQuitEvents, takeQuitReason } = await import('./quitReason');
  const addon = fakeAddon([{ reason: 'quit', ageMs: 12 }]);
  const load = vi.fn(() => addon);
  watchQuitEvents(load);
  expect(load).toHaveBeenCalledWith(path.join('/repo', 'resources', 'native', 'darwin', 'quit-reason.node'));
  expect(takeQuitReason()).toBe('quit');
  expect(takeQuitReason()).toBeNull();
});

it('ignores a quit event too old to have started this quit', async () => {
  const { watchQuitEvents, takeQuitReason } = await import('./quitReason');
  watchQuitEvents(() => fakeAddon([{ reason: 'quit', ageMs: 5_000 }]));
  expect(takeQuitReason()).toBeNull();
});

it('reports nothing off macOS, or when the addon is missing or its handler did not install', async () => {
  setPlatform('win32');
  let mod = await import('./quitReason');
  const load = vi.fn(() => fakeAddon([{ reason: 'quit', ageMs: 1 }]));
  mod.watchQuitEvents(load);
  expect(load).not.toHaveBeenCalled();
  expect(mod.takeQuitReason()).toBeNull();

  setPlatform('darwin');
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.resetModules();
  mod = await import('./quitReason');
  mod.watchQuitEvents(() => { throw new Error('dlopen failed'); });
  expect(mod.takeQuitReason()).toBeNull();

  vi.resetModules();
  mod = await import('./quitReason');
  mod.watchQuitEvents(() => fakeAddon([{ reason: 'quit', ageMs: 1 }], false));
  expect(mod.takeQuitReason()).toBeNull();
  expect(error).toHaveBeenCalledTimes(2);
  error.mockRestore();
});

it('asks before a Dock Quit only with confirmation on, and never for logout, restart or shutdown', async () => {
  const { watchQuitEvents } = await import('./quitReason');
  const { confirmsSystemQuit } = await import('./quit');
  watchQuitEvents(() => fakeAddon([
    { reason: 'quit', ageMs: 3 },
    { reason: 'logout', ageMs: 3 },
    { reason: 'restart', ageMs: 3 },
    { reason: 'shutdown', ageMs: 3 },
    { reason: 'quit', ageMs: 3 },
  ]));
  expect(confirmsSystemQuit()).toBe(true);
  expect(confirmsSystemQuit()).toBe(false);
  expect(confirmsSystemQuit()).toBe(false);
  expect(confirmsSystemQuit()).toBe(false);
  settings.confirmQuit = false;
  expect(confirmsSystemQuit()).toBe(false);
  // The app's own quits (menu Quit after its dialog, updates) carry no quit event.
  settings.confirmQuit = true;
  expect(confirmsSystemQuit()).toBe(false);
});
