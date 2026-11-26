import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { NOTICE_OVERLAY_ARG } from '@shared/ipc';
import { normalizeSettings } from '@shared/settings';
import { HOUR_CYCLE_ARG } from '@shared/timeFormat';

const electron = vi.hoisted(() => ({ ready: false }));
// Electron 45's own pre-ready behaviour (electron_api_app.cc): the system locale throws until ready.
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    isReady: () => electron.ready,
    getSystemLocale: () => {
      if (!electron.ready) throw new Error('app.getSystemLocale() can only be called after app is ready');
      return 'en-US';
    },
    commandLine: { getSwitchValue: () => '' },
  },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      isCrashed: () => false,
      isLoading: () => false,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    });
    loadFile = vi.fn().mockResolvedValue(undefined);
    show = vi.fn();
    focus = vi.fn();
    setMenuBarVisibility = vi.fn();
    isDestroyed = () => false;
    isMaximized = () => false;
    isMinimized = () => false;
  },
  ipcMain: {}, nativeTheme: {}, Notification: {}, screen: {}, shell: {}, safeStorage: {},
}));

// `defaults` reports no clock toggle, so macOS falls through to the region locale whatever this host sets.
vi.mock('node:child_process', () => ({ spawnSync: () => ({ status: 1, stdout: '' }) }));
vi.mock('./paths', () => ({ appPaths: { windowStateFile: '' }, appIconPath: () => '', shellIconPath: () => '' }));
vi.mock('./settingsStore', () => ({ getSettings: () => normalizeSettings({}) }));

const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'darwin' });
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

it('reads the OS clock only after app ready, so importing window modules never touches ready-only APIs', async () => {
  const { rendererPreferences } = await import('./window');
  await import('./notifier');
  const { systemHourCycle } = await import('./hourCycle');
  expect(() => systemHourCycle()).toThrow(/before app ready/);
  electron.ready = true;
  expect(rendererPreferences().additionalArguments).toEqual([`${HOUR_CYCLE_ARG}h12`, NOTICE_OVERLAY_ARG]);
});

const RELOAD_DELAYS_MS = [500, 1_000, 2_000] as const;
const FIRST_RELOAD_DELAY_MS = RELOAD_DELAYS_MS[0];

describe('main window renderer recovery', () => {
  let windowModule: typeof import('./window');
  let mainWindow: BrowserWindow;
  const rendererGone = (reason = 'oom') => {
    mainWindow.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 });
  };
  const failed = (code: number, isMainFrame: boolean) => {
    mainWindow.webContents.emit('did-fail-load', {}, code, 'load failed', 'file:///index.html', isMainFrame);
  };
  const exhaustReloads = () => {
    for (const delay of RELOAD_DELAYS_MS) {
      rendererGone();
      vi.advanceTimersByTime(delay);
      mainWindow.webContents.emit('did-finish-load');
    }
    rendererGone();
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    electron.ready = true;
    windowModule = await import('./window');
    mainWindow = windowModule.createMainWindow(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reloads a crashed hidden renderer after backoff', () => {
    rendererGone();
    expect(console.error).toHaveBeenCalledWith('[window] renderer process gone (reason=oom, exitCode=1)');
    vi.advanceTimersByTime(FIRST_RELOAD_DELAY_MS - 1);
    expect(mainWindow.loadFile).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(mainWindow.loadFile).toHaveBeenCalledTimes(2);
    expect(mainWindow.show).not.toHaveBeenCalled();
  });

  it('ignores clean exits and cancels recovery on quit', () => {
    rendererGone('clean-exit');
    vi.runAllTimers();
    expect(console.error).not.toHaveBeenCalled();
    expect(mainWindow.loadFile).toHaveBeenCalledOnce();

    rendererGone();
    windowModule.markQuitting();
    rendererGone();
    vi.runAllTimers();
    expect(console.error).toHaveBeenCalledOnce();
    expect(mainWindow.loadFile).toHaveBeenCalledOnce();
  });

  it('caps reloads across successful page loads and notifies once', () => {
    const onCap = vi.fn();
    windowModule.onRendererCrashCap(onCap);
    exhaustReloads();
    rendererGone();
    vi.runAllTimers();
    expect(mainWindow.loadFile).toHaveBeenCalledTimes(4);
    expect(onCap).toHaveBeenCalledExactlyOnceWith({ reason: 'oom', count: 4 });
  });

  it('reloads on show after a capped error page finishes loading and resets the crash streak', () => {
    const onCap = vi.fn();
    windowModule.onRendererCrashCap(onCap);
    exhaustReloads();
    failed(-6, true);
    mainWindow.webContents.emit('did-finish-load');

    windowModule.showMainWindow();
    expect(mainWindow.loadFile).toHaveBeenCalledTimes(5);
    expect(mainWindow.show).toHaveBeenCalledOnce();

    exhaustReloads();
    expect(mainWindow.loadFile).toHaveBeenCalledTimes(8);
    expect(onCap).toHaveBeenCalledTimes(2);
    expect(onCap).toHaveBeenLastCalledWith({ reason: 'oom', count: 4 });
  });

  it('keeps the pending reload and crash streak when shown during backoff', () => {
    vi.spyOn(mainWindow.webContents, 'isCrashed').mockReturnValue(true);
    rendererGone();

    windowModule.showMainWindow();
    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(mainWindow.loadFile).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(mainWindow.loadFile).toHaveBeenCalledTimes(2);

    rendererGone();
    vi.advanceTimersByTime(RELOAD_DELAYS_MS[1] - 1);
    expect(mainWindow.loadFile).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(mainWindow.loadFile).toHaveBeenCalledTimes(3);
  });

  it('delivers a show-and-send event to the reloaded page when shown during backoff', () => {
    rendererGone();
    windowModule.showWindowAndSend('channel', 'payload');
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('channel', 'payload');
    vi.runAllTimers();
    mainWindow.webContents.emit('did-finish-load');
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('channel', 'payload');
  });

  it('only recovers from a main-frame navigation failure that was not aborted', () => {
    failed(-6, false);
    failed(-3, true);
    vi.runAllTimers();
    expect(console.error).not.toHaveBeenCalled();
    expect(mainWindow.loadFile).toHaveBeenCalledOnce();

    failed(-6, true);
    vi.advanceTimersByTime(FIRST_RELOAD_DELAY_MS);
    expect(console.error).toHaveBeenCalledOnce();
    expect(mainWindow.loadFile).toHaveBeenCalledTimes(2);
  });
});
