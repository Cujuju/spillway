/** Spillway notifications: one shape for the OS notification and the overlay window (settings.notifications.delivery). */

export type NoticeKind = 'limitHit' | 'limitReset' | 'accountSwitched' | 'proxyStopped' | 'updateFound' | 'clientDrift';
/** What clicking a notice opens. */
export const NOTICE_TARGETS = ['window', 'proxy', 'updates'] as const;
export type NoticeTarget = (typeof NOTICE_TARGETS)[number];
export type NoticeTone = 'warn' | 'ok' | 'info' | 'error';

/** Where notifications show. */
export const NOTICE_DELIVERIES = ['spillway', 'system', 'both'] as const;
export type NoticeDelivery = (typeof NOTICE_DELIVERIES)[number];
/** Overlay looks: cards by the tray, a lip at the top edge, or log lines. */
export const NOTICE_STYLES = ['tray', 'drip', 'console'] as const;
export type NoticeStyle = (typeof NOTICE_STYLES)[number];

export const MIN_CONSOLE_LINES = 2;
export const MAX_CONSOLE_LINES = 8;

export interface NoticeInput {
  kind: NoticeKind;
  /** OS title; overlay headline. */
  title: string;
  /** OS body; overlay detail. May be empty. */
  body: string;
  /** Top drip's resting lip; a few words. */
  short: string;
  target: NoticeTarget;
}

export interface Notice extends NoticeInput {
  id: number;
  /** Epoch ms. */
  at: number;
}

export const NOTICE_TONE: Record<NoticeKind, NoticeTone> = {
  limitHit: 'warn',
  limitReset: 'ok',
  accountSwitched: 'info',
  proxyStopped: 'error',
  updateFound: 'info',
  clientDrift: 'warn',
};

/** Errors stay on screen until clicked or dismissed. */
export const isSticky = (n: NoticeInput): boolean => NOTICE_TONE[n.kind] === 'error';

export const deliversTo = (d: NoticeDelivery): { system: boolean; overlay: boolean } => ({ system: d !== 'spillway', overlay: d !== 'system' });
