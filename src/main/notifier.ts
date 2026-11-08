import { BrowserWindow, ipcMain, nativeTheme, Notification, screen } from 'electron';
import { createNoticeOverlay, createNotifier, handleNoticeIpc, OVERLAY_WINDOW_OPTIONS, type NoticeInput } from '@cujuju/electron-notices';
import { APP_NAME } from '@shared/app';
import { EVENTS } from '@shared/ipc';
import { noticeView, spillwayNotice } from '@shared/notice';
import { appIconPath } from './paths';
import { getSettings, onSettingsChange } from './settingsStore';
import { loadRendererPage, rendererPreferences, showMainWindow, showWindowAndSend } from './window';

export const noticeOverlay = createNoticeOverlay({
  createWindow() {
    const w = new BrowserWindow({ ...OVERLAY_WINDOW_OPTIONS, title: `${APP_NAME} notifications`, webPreferences: rendererPreferences });
    loadRendererPage(w, 'notice.html');
    return w;
  },
  primaryDisplay: () => screen.getPrimaryDisplay(),
  view: () => noticeView(getSettings(), nativeTheme.shouldUseDarkColors),
  platform: process.platform,
  onOpen: (n) => openNoticeTarget(n.target),
});
export function openNoticeTarget(target: string | undefined): void {
  if (target === 'proxy') showWindowAndSend(EVENTS.onOpenProxy);
  else if (target === 'updates') showWindowAndSend(EVENTS.onOpenSettings, 'updates');
  else showMainWindow();
}
const notifier = createNotifier({
  overlay: noticeOverlay,
  delivery: () => getSettings().notifications.delivery,
  system(input) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: input.title, body: input.body, icon: appIconPath() });
    n.on('click', () => openNoticeTarget(input.target));
    n.show();
  },
});
export function notify(input: NoticeInput): void { void notifier.notify(input); }
export function startNotices(): void {
  handleNoticeIpc(ipcMain, noticeOverlay);
  noticeOverlay.refresh();
  onSettingsChange(noticeOverlay.refresh);
  nativeTheme.on('updated', noticeOverlay.refresh);
  screen.on('display-metrics-changed', noticeOverlay.refresh);
  screen.on('display-added', noticeOverlay.refresh);
  screen.on('display-removed', noticeOverlay.refresh);
}

const PREVIEWS: NoticeInput[] = [
  spillwayNotice('limitHit', { target: 'window', title: 'Preview: 5-hour limit reached', body: 'Switching to the next account.', short: 'Preview: limit reached' }),
  spillwayNotice('accountSwitched', { target: 'window', title: 'Preview: now using another account', body: 'New conversations go to the next account.', short: 'Preview: switched' }),
  spillwayNotice('limitReset', { target: 'window', title: 'Preview: limit reset', body: 'The account is available again.', short: 'Preview: limit reset' }),
  spillwayNotice('proxyStopped', { target: 'proxy', title: 'Preview: proxy stopped', body: 'Errors stay until you click or dismiss them.', short: 'Preview: proxy stopped' }),
];
let previewIndex = 0;

export function previewNotice(): void {
  notify(PREVIEWS[previewIndex % PREVIEWS.length]!);
  previewIndex++;
}
