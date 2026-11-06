import { BrowserWindow, screen } from 'electron';
import { APP_NAME } from '@shared/app';
import { EVENTS } from '@shared/ipc';
import { deliversTo, type Notice } from '@shared/notice';
import { overlayBounds } from './noticePlacement';
import { getSettings, onSettingsChange } from './settingsStore';
import { loadRendererPage, rendererPreferences } from './window';

/** The page paints only its notices; everything else shows the desktop through. */
const TRANSPARENT = '#00000000';
const isMac = process.platform === 'darwin';
/** Electron forwards mouse moves through an ignoring window on Windows and macOS only; Linux keeps the window clickable. */
const FORWARDS_MOUSE = process.platform !== 'linux';

let win: BrowserWindow | null = null;
let loaded = false;
const queued: Notice[] = [];
/** The renderer's content size; zero hides the window. */
let content = { width: 0, height: 0 };

const live = () => (win && !win.isDestroyed() ? win : null);

function create(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1, height: 1, show: false, title: `${APP_NAME} notifications`,
    frame: false, transparent: true, backgroundColor: TRANSPARENT, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    // Never takes focus or a taskbar entry: typing stays in the app underneath.
    focusable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: rendererPreferences,
  });
  // Above the taskbar and full-screen windows.
  w.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Windows keeps windows at least ~39 px tall, more than the drip's lip; clicks off a notice pass through to the app below.
  if (FORWARDS_MOUSE) w.setIgnoreMouseEvents(true, { forward: true });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('did-finish-load', () => {
    loaded = true;
    for (const n of queued.splice(0)) w.webContents.send(EVENTS.onNotice, n);
  });
  w.on('closed', () => {
    win = null;
    loaded = false;
    content = { width: 0, height: 0 };
  });
  loadRendererPage(w, 'notice.html');
  return w;
}

const ensure = () => live() ?? (win = create());

function place(): void {
  const w = live();
  if (!w) return;
  if (content.width <= 0 || content.height <= 0) {
    w.hide();
    return;
  }
  w.setBounds(overlayBounds(getSettings().notifications.style, content, screen.getPrimaryDisplay()));  if (!w.isVisible()) w.showInactive();
}

/** Top drip's resting lip shows between notices, so the window must exist before the first one. */
function sync(): void {
  const n = getSettings().notifications;
  if (deliversTo(n.delivery).overlay && n.style === 'drip' && n.dripLip) ensure();
  const w = live();
  if (w && loaded) w.webContents.send(EVENTS.onSettings, getSettings());
  place();
}

export const noticeOverlay = {
  start(): void {
    sync();
    onSettingsChange(sync);
    screen.on('display-metrics-changed', place);
    screen.on('display-added', place);
    screen.on('display-removed', place);
  },
  show(notice: Notice): void {
    const w = ensure();
    if (loaded) w.webContents.send(EVENTS.onNotice, notice);
    else queued.push(notice);
  },
  resize(width: number, height: number): void {
    const valid = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
    content = { width: valid(width), height: valid(height) };
    place();
  },
  /** The renderer reports when the pointer is over a notice, which then takes the click. */
  pointer(over: boolean): void {
    if (FORWARDS_MOUSE) live()?.setIgnoreMouseEvents(!over, { forward: true });
  },
  destroy(): void {
    live()?.destroy();
  },
};
