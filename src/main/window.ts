import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { APP_NAME } from '@shared/app';
import { EVENTS } from '@shared/ipc';
import { resolveTheme } from '@shared/themes';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appIconPath, appPaths } from './paths';
import { getSettings, writeFileAtomic } from './settingsStore';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const STATE_SAVE_DEBOUNCE_MS = 500;
const isMac = process.platform === 'darwin';
/** Centres the macOS traffic lights (about 14px tall) in the 36px --titlebar-height. */
const TRAFFIC_LIGHTS = { x: 14, y: 11 };

/** Windows draws its own title bar controls in the renderer; macOS keeps native traffic lights. */
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

let win: BrowserWindow | null = null;
let quitting = false;
let saveTimer: NodeJS.Timeout | null = null;

export const markQuitting = () => {
  quitting = true;
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
  const w = mainWindow() ?? createMainWindow(true);
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
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
    icon: appIconPath(),
    title: APP_NAME,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (saved?.maximized) win.maximize();
  win.setMenuBarVisibility(false);
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', () => win?.webContents.send(EVENTS.onMaximized, true));
  win.on('unmaximize', () => win?.webContents.send(EVENTS.onMaximized, false));
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
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}
