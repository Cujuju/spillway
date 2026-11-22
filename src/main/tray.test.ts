import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ trays: [] as { setContextMenu: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setToolTip: ReturnType<typeof vi.fn> }[],
  trayIcons: { enabled: true, showAppIcon: true, items: [{ id: 'limit' }] },
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
  getSettings: () => ({ trayIcons: state.trayIcons }),
  onSettingsChange: (fn: () => void) => { state.settingsChanged = fn; return state.unsubscribe; },
}));
afterEach(async () => {
  const { destroyTrays } = await import('./tray');
  destroyTrays();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.trays.length = 0;
  state.trayIcons = { enabled: true, showAppIcon: true, items: [{ id: 'limit' }] };
});

it('registers Linux menus on every icon, refreshes them on state changes, and removes subscriptions on shutdown', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  const { startTrays, syncLimitTrays, destroyTrays } = await import('./tray');
  const { usage } = await import('./usagePoller');
  const { proxy } = await import('./proxySupervisor');
  startTrays();
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

it('keeps a tray entry point as limit icons appear, are disabled, or are removed', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  const { startTrays, syncLimitTrays, setAppTrayTooltip } = await import('./tray');
  const limit = { id: 'limit', png1x: '', png2x: '', tooltip: 'limit' };
  const visible = () => state.trays.filter((tray) => !tray.destroy.mock.calls.length);
  state.trayIcons.showAppIcon = false;
  startTrays();
  const [startupIcon] = visible();
  expect(startupIcon).toBeDefined();

  syncLimitTrays([limit]);
  const [, limitIcon] = state.trays;
  expect(visible()).toEqual([limitIcon]);
  setAppTrayTooltip('Latest tooltip');

  state.trayIcons.enabled = false;
  state.settingsChanged!();
  syncLimitTrays([]);
  expect(visible()).toHaveLength(1);
  expect(visible()[0]!.setToolTip).toHaveBeenCalledWith('Latest tooltip');

  state.trayIcons.enabled = true;
  state.settingsChanged!();
  syncLimitTrays([limit]);
  const [replacementLimit] = visible();
  expect(replacementLimit!.setToolTip).toHaveBeenCalledWith('limit');

  state.trayIcons.showAppIcon = true;
  state.settingsChanged!();
  expect(visible()).toHaveLength(2);
  state.trayIcons.showAppIcon = false;
  state.settingsChanged!();
  expect(visible()).toEqual([replacementLimit]);

  state.trayIcons.items = [];
  state.settingsChanged!();
  syncLimitTrays([]);
  expect(visible()).toHaveLength(1);
  expect(visible()[0]!.setToolTip).toHaveBeenCalledWith('Latest tooltip');
});
