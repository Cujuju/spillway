import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

type MockTray = {
  image: unknown;
  setImage: ReturnType<typeof vi.fn>;
  setContextMenu: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setToolTip: ReturnType<typeof vi.fn>;
};
const state = vi.hoisted(() => ({ trays: [] as MockTray[],
  trayIcons: { enabled: true, showAppIcon: true, items: [{ id: 'limit' }] },
  settingsChanged: undefined as (() => void) | undefined, unsubscribe: vi.fn(),
}));
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: unknown) => template },
  nativeTheme: { shouldUseDarkColorsForSystemIntegratedUI: true },
  nativeImage: { createFromPath: vi.fn(), createEmpty: () => ({ addRepresentation: vi.fn() }) },
  Tray: class {
    image: unknown;
    setContextMenu = vi.fn(); destroy = vi.fn(); on = vi.fn(); setToolTip = vi.fn(); setImage = vi.fn();
    constructor(...args: unknown[]) {
      expect(args).toHaveLength(process.platform === 'linux' ? 1 : 2);
      this.image = args[0];
      state.trays.push(this);
    }
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

it('updates Windows limit images and tooltips only when their inputs change', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const { startTrays, syncLimitTrays } = await import('./tray');
  startTrays();
  const initial = { id: 'limit', png1x: 'original 1x', png2x: 'original 2x', tooltip: 'original tooltip' };
  syncLimitTrays([initial]);
  const tray = state.trays[1]!;
  expect(tray.setToolTip).toHaveBeenCalledWith(initial.tooltip);

  syncLimitTrays([{ ...initial }]);
  expect(tray.setImage).not.toHaveBeenCalled();
  expect(tray.setToolTip).toHaveBeenCalledOnce();

  const changed = { ...initial, png2x: 'new 2x' };
  syncLimitTrays([changed]);
  expect(tray.setImage).toHaveBeenCalledOnce();
  expect(tray.setToolTip).toHaveBeenCalledOnce();

  const final = { ...changed, tooltip: 'new tooltip' };
  syncLimitTrays([final]);
  expect(tray.setImage).toHaveBeenCalledOnce();
  expect(tray.setToolTip).toHaveBeenCalledTimes(2);
  expect(tray.setToolTip).toHaveBeenLastCalledWith(final.tooltip);

  syncLimitTrays([]);
  expect(tray.destroy).toHaveBeenCalledOnce();
  syncLimitTrays([final]);
  const replacement = state.trays[2]!;
  expect(replacement.image).toBeDefined();
  expect(replacement.setToolTip).toHaveBeenCalledExactlyOnceWith(final.tooltip);
});

it('applies the app tooltip on creation and skips duplicate updates', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const { startTrays, setAppTrayTooltip } = await import('./tray');
  setAppTrayTooltip('Before startup');
  startTrays();
  const tray = state.trays[0]!;
  expect(tray.setToolTip).toHaveBeenCalledExactlyOnceWith('Before startup');
  setAppTrayTooltip('Before startup');
  setAppTrayTooltip('Updated');
  setAppTrayTooltip('Updated');
  expect(tray.setToolTip.mock.calls).toEqual([['Before startup'], ['Updated']]);
});
