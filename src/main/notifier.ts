import { Notification } from 'electron';
import { EVENTS } from '@shared/ipc';
import { deliversTo, type NoticeInput, type NoticeTarget } from '@shared/notice';
import { noticeOverlay } from './noticeOverlay';
import { appIconPath } from './paths';
import { getSettings } from './settingsStore';
import { showMainWindow, showWindowAndSend } from './window';

let nextId = 1;

export function openNoticeTarget(target: NoticeTarget): void {
  if (target === 'proxy') showWindowAndSend(EVENTS.onOpenProxy);
  else if (target === 'updates') showWindowAndSend(EVENTS.onOpenSettings, 'updates');
  else showMainWindow();
}

/** Every Spillway notification goes through here, so the delivery setting covers all of them. */
export function notify(input: NoticeInput): void {
  const to = deliversTo(getSettings().notifications.delivery);
  if (to.system && Notification.isSupported()) {
    const n = new Notification({ title: input.title, body: input.body, icon: appIconPath() });
    n.on('click', () => openNoticeTarget(input.target));
    n.show();
  }
  if (to.overlay) noticeOverlay.show({ ...input, id: nextId++, at: Date.now() });
}

/** Settings → Notifications → Preview: one of each tone in turn, through the chosen delivery. */
const PREVIEWS: NoticeInput[] = [
  { kind: 'limitHit', target: 'window', title: 'Preview: 5-hour limit reached', body: 'Switching to the next account.', short: 'Preview: limit reached' },
  { kind: 'accountSwitched', target: 'window', title: 'Preview: now using another account', body: 'New conversations go to the next account.', short: 'Preview: switched' },
  { kind: 'limitReset', target: 'window', title: 'Preview: limit reset', body: 'The account is available again.', short: 'Preview: limit reset' },
  { kind: 'proxyStopped', target: 'proxy', title: 'Preview: proxy stopped', body: 'Errors stay until you click or dismiss them.', short: 'Preview: proxy stopped' },
];
let previewIndex = 0;

export function previewNotice(): void {
  notify(PREVIEWS[previewIndex % PREVIEWS.length]!);
  previewIndex++;
}
