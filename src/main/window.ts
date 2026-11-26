import { HOUR_CYCLE_ARG } from '@shared/timeFormat';
import { systemHourCycle } from './hourCycle';
import { supportsNoticeOverlay } from '@cujuju/electron-notices';
import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { APP_NAME } from '@shared/app';
import { EVENTS, NOTICE_OVERLAY_ARG } from '@shared/ipc';
import { resolveTheme } from '@shared/themes';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appPaths, shellIconPath } from './paths';
import { getSettings, writeFileAtomic } from './settingsStore';
import { CrashWindow } from './crashWindow';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const STATE_SAVE_DEBOUNCE_MS = 500;
// Bound repeated reloads after a persistent renderer failure.
const RENDERER_MAX_RELOADS = 3;
// Count failures across successful page loads within a crash streak.
const RENDERER_CRASH_WINDOW_MS = 2 * 60_000;
// Pause briefly before trying to start the renderer again.
const RENDERER_RELOAD_BACKOFF_BASE_MS = 500;
// Chromium net::ERR_ABORTED includes benign cancellation when a new navigation starts.
const ERR_ABORTED = -3;
const isMac = process.platform === 'darwin';
/** Centres the macOS traffic lights (about 14px tall) in the 36px --titlebar-height. */
const TRAFFIC_LIGHTS = { x: 14, y: 11 };

/** Windows and Linux draw title bar controls in the renderer; macOS keeps native traffic lights. */
const chrome: Electron.BrowserWindowConstructorOptions = isMac
  ? { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS }
  : { frame: false };

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface RendererCrashInfo {
  readonly reason: string;
  readonly count: number;
}

let win: BrowserWindow | null = null;
let quitting = false;
let saveTimer: NodeJS.Timeout | null = null;
const rendererCrashWindow = new CrashWindow({
  maxAttempts: RENDERER_MAX_RELOADS, windowMs: RENDERER_CRASH_WINDOW_MS, backoffBaseMs: RENDERER_RELOAD_BACKOFF_BASE_MS,
});
let rendererCapped = false;
let reloadTimer: NodeJS.Timeout | null = null;
let crashCapListener: ((info: RendererCrashInfo) => void) | undefined;

export function onRendererCrashCap(listener: (info: RendererCrashInfo) => void): void {
  crashCapListener = listener;
}

function clearReloadTimer(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = null;
}

export const markQuitting = () => {
  quitting = true;
  clearReloadTimer();
};
export const isQuitting = () => quitting;
export const mainWindow = () => (win && !win.isDestroyed() ? win : null);

function loadState(): WindowState | null {
  try {
    if (!existsSync(appPaths.windowStateFile)) return null;
    const s = JSON.parse(readFileSync(appPaths.windowStateFile, 'utf8')) as WindowState;
    if (typeof s.width !== 'number' || typeof s.height !== 'number') return null;
    // Drop a position that no longer lands on any display (monitor unplugged).
    const onScreen = s.x !== undefined && s.y !== undefined &&
      screen.getAllDisplays().some(({ workArea: a }) => s.x! >= a.x && s.y! >= a.y && s.x! < a.x + a.width && s.y! < a.y + a.height);
    return onScreen ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return null;
  }
}

function saveState(): void {
  const w = mainWindow();
  if (!w) return;
  const b = w.getNormalBounds();
  writeFileAtomic(appPaths.windowStateFile, JSON.stringify({ ...b, maximized: w.isMaximized() }));
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, STATE_SAVE_DEBOUNCE_MS);
}

/** The theme's page colour, so the first frame and resize edges match the UI. */
const themeBackground = () => resolveTheme(getSettings().general.theme, nativeTheme.shouldUseDarkColors).palette.background;

export function syncWindowBackground(): void {
  mainWindow()?.setBackgroundColor(themeBackground());
}

export function showMainWindow(): void {
  const existing = mainWindow();
  const w = existing ?? createMainWindow(true);
  if (existing && !reloadTimer && (rendererCapped || w.webContents.isCrashed())) {
    if (rendererCapped) {
      rendererCapped = false;
      rendererCrashWindow.reset();
    }
    loadRendererPage(w, 'index.html');
  }
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

export const noticeOverlayEnvironment = {
  platform: process.platform,
  sessionType: process.env.XDG_SESSION_TYPE,
  ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
};
export const noticeOverlaySupported = supportsNoticeOverlay(noticeOverlayEnvironment);

/** Every renderer page runs sandboxed behind the same preload (window.api). Built per window: the OS clock read needs app ready. */
export function rendererPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(import.meta.dirname, '../preload/index.cjs'),
    // Renderers format times with the OS clock setting, read once at launch.
    additionalArguments: [HOUR_CYCLE_ARG + (systemHourCycle() ?? ''), ...(noticeOverlaySupported ? [NOTICE_OVERLAY_ARG] : [])],
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

/** Loads a renderer page from the dev server in development, else from the build. */
export function loadRendererPage(w: BrowserWindow, page: 'index.html' | 'notice.html'): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const load = !app.isPackaged && devUrl
    ? w.loadURL(new URL(page, `${devUrl}/`).href)
    : w.loadFile(path.join(import.meta.dirname, '../renderer', page));
  // did-fail-load reports navigation failures.
  void load.catch(() => {});
}

function scheduleRendererRecovery(reason: string): void {
  if (reloadTimer || rendererCapped) return;
  const decision = rendererCrashWindow.record();
  if (decision.action === 'give-up') {
    rendererCapped = true;
    console.error(`[window] renderer reload cap reached (reason=${reason}, count=${decision.count})`);
    crashCapListener?.({ reason, count: decision.count });
    return;
  }
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const w = mainWindow();
    if (w && !quitting) loadRendererPage(w, 'index.html');
  }, decision.delayMs);
}

/** Shows the window and sends it one event. A window still loading gets it after load; sent earlier, the renderer misses it. */
export function showWindowAndSend(channel: string, payload?: unknown): void {
  showMainWindow();
  const contents = mainWindow()?.webContents;
  if (!contents) return;
  const send = () => contents.send(channel, payload);
  // A renderer awaiting a crash reload is dead but not loading; the reload delivers it.
  if (contents.isLoading() || reloadTimer) contents.once('did-finish-load', send);
  else send();
}

export function createMainWindow(show: boolean): BrowserWindow {
  const saved = loadState();
  win = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WIDTH,
    height: saved?.height ?? DEFAULT_HEIGHT,
    ...(saved?.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    ...chrome,
    show: false,
    backgroundColor: themeBackground(),
    icon: shellIconPath(),
    title: APP_NAME,
    webPreferences: rendererPreferences(),
  });
  if (saved?.maximized) win.maximize();
  win.setMenuBarVisibility(false);
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', () => win?.webContents.send(EVENTS.onMaximized, true));
  win.on('unmaximize', () => win?.webContents.send(EVENTS.onMaximized, false));
  // Events fire only on change; a fresh page (launch maximized, reload) needs the current state.
  win.webContents.on('did-finish-load', () => {
    if (win) win.webContents.send(EVENTS.onMaximized, win.isMaximized());
  });
  win.webContents.on('render-process-gone', (_event, { reason, exitCode }) => {
    if (quitting || reason === 'clean-exit') return;
    console.error(`[window] renderer process gone (reason=${reason}, exitCode=${exitCode})`);
    scheduleRendererRecovery(reason);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (quitting || !isMainFrame || code === ERR_ABORTED) return;
    console.error(`[window] page failed to load (code=${code}, description=${description}, url=${url})`);
    scheduleRendererRecovery(description);
  });
  win.webContents.on('unresponsive', () => console.warn('[window] renderer unresponsive'));
  win.webContents.on('responsive', () => console.warn('[window] renderer responsive'));
  win.on('close', (e) => {
    saveState();
    if (!quitting && getSettings().general.closeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  // 'minimize' is not cancellable; hide the minimized window so it leaves the taskbar.
  win.on('minimize', () => {
    if (getSettings().general.minimizeToTray) win?.hide();
  });
  // macOS: a tray-only app leaves the Dock and Cmd-Tab while its window is hidden.
  if (isMac) {
    win.on('hide', () => app.dock?.hide());
    win.on('show', () => void app.dock?.show());
  }
  win.on('closed', () => {
    clearReloadTimer();
    win = null;
    if (!quitting && !getSettings().general.closeToTray) app.quit();
  });
  // Links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => {
    if (show) win?.show();
  });
  loadRendererPage(win, 'index.html');
  return win;
}
