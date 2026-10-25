import { Menu, nativeImage, Tray } from 'electron';
import { createHash } from 'node:crypto';
import { appIconPath } from './paths';
import { proxy } from './proxySupervisor';
import { requestQuit } from './quit';
import { usage } from './usagePoller';
import { showMainWindow } from './window';

export interface LimitTrayImage {
  id: string;
  /** PNG data URLs rendered by the renderer at 1x and 2x tray size. */
  png1x: string;
  png2x: string;
  tooltip: string;
}

let appTray: Tray | null = null;
const limitTrays = new Map<string, Tray>();

/** Stable per-icon GUID so Windows remembers each icon's "always show" choice. */
function guidFor(id: string): string {
  const h = createHash('sha1').update(`cliproxy-desktop:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function contextMenu(): Menu {
  const running = proxy.isRunning();
  return Menu.buildFromTemplate([
    { label: 'Open CLIProxy Desktop', click: showMainWindow },
    { type: 'separator' },
    { label: `Proxy: ${proxy.getStatus().state}`, enabled: false },
    running
      ? { label: 'Stop proxy', click: () => void proxy.stop() }
      : { label: 'Start proxy', click: () => void proxy.start() },
    { label: 'Restart proxy', enabled: running, click: () => void proxy.restart() },
    { label: 'Refresh usage', enabled: running, click: () => void usage.refresh().catch(() => undefined) },
    { type: 'separator' },
    { label: 'Quit', click: () => void requestQuit() },
  ]);
}

function attach(tray: Tray): void {
  tray.on('click', showMainWindow);
  tray.on('right-click', () => tray.popUpContextMenu(contextMenu()));
}

export function ensureAppTray(): void {
  if (appTray) return;
  appTray = new Tray(nativeImage.createFromPath(appIconPath()), guidFor('app'));
  appTray.setToolTip('CLIProxy Desktop');
  attach(appTray);
}

export function setAppTrayTooltip(text: string): void {
  appTray?.setToolTip(text);
}

function imageOf(i: LimitTrayImage): Electron.NativeImage {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, dataURL: i.png1x });
  img.addRepresentation({ scaleFactor: 2, dataURL: i.png2x });
  return img;
}

/** Creates, updates and removes limit icons to match exactly `images`. */
export function syncLimitTrays(images: LimitTrayImage[]): void {
  const wanted = new Set(images.map((i) => i.id));
  for (const [id, tray] of limitTrays) {
    if (wanted.has(id)) continue;
    tray.destroy();
    limitTrays.delete(id);
  }
  for (const i of images) {
    let tray = limitTrays.get(i.id);
    if (!tray) {
      tray = new Tray(imageOf(i), guidFor(i.id));
      attach(tray);
      limitTrays.set(i.id, tray);
    } else {
      tray.setImage(imageOf(i));
    }
    tray.setToolTip(i.tooltip);
  }
}

export function destroyTrays(): void {
  appTray?.destroy();
  appTray = null;
  syncLimitTrays([]);
}
