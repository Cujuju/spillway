import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ trays: [] as { setContextMenu: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[],
  settingsChanged: undefined as (() => void) | undefined, unsubscribe: vi.fn(),
}));
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: unknown) => template },
  nativeTheme: { shouldUseDarkColorsForSystemIntegratedUI: true },
  nativeImage: { createFromPath: vi.fn(), createEmpty: () => ({ addRepresentation: vi.fn() }) },
  Tray: class {
    setContextMenu = vi.fn(); destroy = vi.fn(); on = vi.fn(); setToolTip = vi.fn();
    constructor(...args: unknown[]) { expect(args).toHaveLength(1); state.trays.push(this); }
  },
}));
vi.mock('./paths', () => ({ shellIconPath: () => '/icon.png', appIconPath: () => '/icon.png' }));
vi.mock('./preferredAccounts', () => ({ usePreferredAccount: vi.fn() }));
vi.mock('./quit', () => ({ requestQuit: vi.fn() }));
vi.mock('./window', () => ({ showMainWindow: vi.fn() }));
vi.mock('./proxySupervisor', () => ({ proxy: Object.assign(new EventEmitter(), { isRunning: () => false, getStatus: () => ({ state: 'stopped' }) }) }));
vi.mock('./usagePoller', () => ({ usage: new EventEmitter() }));
vi.mock('./settingsStore', () => ({
  onSettingsChange: (fn: () => void) => { state.settingsChanged = fn; return state.unsubscribe; },
}));
afterEach(() => vi.unstubAllGlobals());

it('registers Linux menus on every icon, refreshes them on state changes, and removes subscriptions on shutdown', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  const { ensureAppTray, syncLimitTrays, destroyTrays } = await import('./tray');
  const { usage } = await import('./usagePoller');
  const { proxy } = await import('./proxySupervisor');
  ensureAppTray();
  syncLimitTrays([{ id: 'limit', png1x: '', png2x: '', tooltip: 'limit' }]);
  for (const tray of state.trays) expect(tray.setContextMenu).toHaveBeenCalledOnce();
  usage.emit('snapshot'); proxy.emit('status'); state.settingsChanged!();
  for (const tray of state.trays) expect(tray.setContextMenu).toHaveBeenCalledTimes(4);
  destroyTrays();
  expect(state.unsubscribe).toHaveBeenCalledOnce();
  expect(usage.listenerCount('snapshot')).toBe(0);
  expect(proxy.listenerCount('status')).toBe(0);
  for (const tray of state.trays) expect(tray.destroy).toHaveBeenCalledOnce();
});
