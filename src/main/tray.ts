import { Menu, nativeImage, nativeTheme, Tray } from 'electron';
import { APP_NAME } from '@shared/app';
import { createHash } from 'node:crypto';
import { maskEmails } from '@shared/privacy';
import { appIconPath } from './paths';
import { usePreferredAccount } from './preferredAccounts';
import { proxy } from './proxySupervisor';
import { requestQuit } from './quit';
import { getSettings } from './settingsStore';
import { usage } from './usagePoller';
import { showMainWindow } from './window';

export interface LimitTrayImage {
  id: string;
  /** PNG data URLs rendered by the renderer at 1x and 2x tray size. */
  png1x: string;
  png2x: string;
  tooltip: string;
}

/** macOS menu bar icons are about 18pt; Windows scales the source icon itself. */
const MENU_BAR_ICON_PT = 18;

/** The taskbar has its own theme, separate from the app theme (Windows "Choose your default Windows mode"). */
export const taskbarDark = () => nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;

let appTray: Tray | null = null;
const limitTrays = new Map<string, Tray>();

/**
 * Stable per-icon GUID so Windows remembers each icon's "always show" choice and macOS its menu bar position.
 * Windows binds a GUID to the first exe that registers it and rejects it from any other path, so the exe path
 * is part of the key: an installed copy, a dev build and a moved folder each get their own icons.
 */
function guidFor(id: string): string {
  const h = createHash('sha1').update(`spillway:${process.execPath.toLowerCase()}:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const choose = (provider: string, authIndex: string) =>
  void usePreferredAccount(provider, authIndex).catch((err: unknown) => console.error('[tray] use account failed:', err));

/** One "Use account" submenu per provider: Automatic, or an account the proxy prefers while it is available. */
function accountMenus(): Electron.MenuItemConstructorOptions[] {
  const { proxy: p, dashboard } = getSettings();
  const credentials = usage.latest()?.credentials.filter((c) => !c.disabled) ?? [];
  const providers = [...new Set(credentials.map((c) => c.provider))].sort();
  return providers.map((provider) => {
    const preferred = p.preferredAccounts[provider] ?? '';
    const accounts = credentials.filter((c) => c.provider === provider);
    return {
      label: providers.length > 1 ? `Use ${provider} account` : 'Use account',
      submenu: [
        { label: 'Automatic', type: 'radio', checked: !preferred, click: () => choose(provider, '') },
        { type: 'separator' },
        ...accounts.map((c): Electron.MenuItemConstructorOptions => ({
          // Menus show on screen, so they honour "Show emails" like the window does.
          label: dashboard.showEmails ? c.label : maskEmails(c.label),
          type: 'radio',
          checked: c.authIndex === preferred,
          click: () => choose(provider, c.authIndex),
        })),
      ],
    };
  });
}

function contextMenu(): Menu {
  const running = proxy.isRunning();
  const accounts = running ? accountMenus() : [];
  return Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: showMainWindow },
    { type: 'separator' },
    { label: `Proxy: ${proxy.getStatus().state}`, enabled: false },
    running
      ? { label: 'Stop proxy', click: () => void proxy.stop() }
      : { label: 'Start proxy', click: () => void proxy.start() },
    { label: 'Restart proxy', enabled: running, click: () => void proxy.restart() },
    { label: 'Refresh usage', enabled: running, click: () => void usage.refresh().catch(() => undefined) },
    ...(accounts.length ? [{ type: 'separator' } as const, ...accounts] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => void requestQuit() },
  ]);
}

function attach(tray: Tray): void {
  tray.on('click', showMainWindow);
  tray.on('right-click', () => tray.popUpContextMenu(contextMenu()));
}

function appTrayImage(): Electron.NativeImage {
  const source = nativeImage.createFromPath(appIconPath());
  if (process.platform !== 'darwin') return source;
  const img = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const px = MENU_BAR_ICON_PT * scaleFactor;
    img.addRepresentation({ scaleFactor, buffer: source.resize({ width: px, height: px, quality: 'best' }).toPNG() });
  }
  return img;
}

export function ensureAppTray(): void {
  if (appTray) return;
  appTray = new Tray(appTrayImage(), guidFor('app'));
  appTray.setToolTip(APP_NAME);
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
