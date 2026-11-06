import type { NoticeInput, NoticeTone, NoticeView } from '@cujuju/electron-notices';
import type { AppSettings } from './settings';
import { darkTheme, resolveTheme, type Palette } from './themes';

export type SpillwayNoticeKind = 'limitHit' | 'limitReset' | 'accountSwitched' | 'proxyStopped' | 'updateFound' | 'clientDrift';
export type SpillwayNoticeTarget = 'window' | 'proxy' | 'updates';
export const NOTICE_KINDS: Record<SpillwayNoticeKind, { tone: NoticeTone; tag: string }> = {
  limitHit: { tone: 'warn', tag: 'LIMIT' },
  limitReset: { tone: 'ok', tag: 'RESET' },
  accountSwitched: { tone: 'info', tag: 'SWITCH' },
  proxyStopped: { tone: 'error', tag: 'PROXY' },
  updateFound: { tone: 'info', tag: 'UPDATE' },
  clientDrift: { tone: 'warn', tag: 'DRIFT' },
};
export function spillwayNotice(kind: SpillwayNoticeKind, input: { title: string; body?: string; short?: string; target?: SpillwayNoticeTarget }): NoticeInput {
  return { ...input, ...NOTICE_KINDS[kind], icon: kind };
}
const vars = (p: Palette): Record<string, string> => ({
  '--notice-surface': p.raised, '--notice-sunken': p.sunken, '--notice-hover': p.hover,
  '--notice-text': p.text, '--notice-text-secondary': p.secondary,
  '--notice-border': p.border, '--notice-border-strong': p.borderStrong,
  '--notice-accent': p.accentLight, '--notice-info': p.accentLight,
  '--notice-ok': p.green, '--notice-warn': p.amber, '--notice-error': p.red,
});
export function noticeView(settings: AppSettings, prefersDark: boolean): NoticeView {
  const theme = resolveTheme(settings.general.theme, prefersDark);
  const { delivery, style, dripLip, consoleLines } = settings.notifications;
  return { config: { delivery, style, dripLip, consoleLines },
    appearance: { vars: vars(theme.palette), dripVars: vars(darkTheme(theme).palette), colorScheme: theme.scheme } };
}
