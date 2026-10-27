import { createMemo, createRoot, createSignal } from 'solid-js';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { maskSnapshot } from '@shared/privacy';
import { rollPastResets } from '@shared/usageWindows';
import { msToNextMinute } from '@shared/resetTime';
import { resolveTheme, themeTokens } from '@shared/themes';
import { rangeDays } from './lib/activityStats';
import { MAX_ACTIVITY_EVENTS, type ActivityBucket, type ActivityEvent, type HistorySample, type LogLine, type ProxyStatus, type UsageSnapshot } from '@shared/types';

export type Page = 'dashboard' | 'accounts' | 'providers' | 'activity' | 'proxy' | 'logs' | 'settings';

const api = window.api;

export const [page, setPage] = createSignal<Page>('dashboard');

export type SettingsSection = 'general' | 'appearance' | 'trayIcons' | 'proxy' | 'dashboard' | 'notifications' | 'updates' | 'advanced';
/** Lives here, not in the Settings page, so other views can open a section directly. */
export const [settingsSection, setSettingsSection] = createSignal<SettingsSection>('general');
export function openSettings(section: SettingsSection): void {
  setSettingsSection(section);
  setPage('settings');
}
export const [settings, setSettingsSignal] = createSignal<AppSettings>(DEFAULT_SETTINGS);
/** Ticks on each wall-clock minute so countdowns re-render without each component owning a timer. */
export const [now, setNow] = createSignal(Date.now());
const [rawSnapshot, setRawSnapshot] = createSignal<UsageSnapshot | null>(null);
export const setSnapshot = setRawSnapshot;
/**
 * What the UI shows: the latest snapshot with windows past their reset rolled to zero, emails masked
 * unless "Show emails" is on. Module-lifetime root.
 */
export const snapshot = createRoot(() =>
  createMemo(() => {
    const raw = rawSnapshot();
    const s = raw && rollPastResets(raw, now());
    return s && !settings().dashboard.showEmails ? maskSnapshot(s) : s;
  }),
);
export const [usageError, setUsageError] = createSignal<string | null>(null);
export const [history, setHistory] = createSignal<HistorySample[]>([]);
export const [proxyStatus, setProxyStatus] = createSignal<ProxyStatus | null>(null);
export const [logs, setLogs] = createSignal<LogLine[]>([]);
export const [activity, setActivity] = createSignal<ActivityEvent[]>([]);
/** Hourly activity for the Activity overview and plan sizing (poolCapacity). */
export const [activityBuckets, setActivityBuckets] = createSignal<ActivityBucket[]>([]);
export const [maximized, setMaximized] = createSignal(false);
export const [taskbarDark, setTaskbarDark] = createSignal(true);

const MAX_LOG_LINES = 2000;
/** History refetch after a snapshot is cheap (local file) and keeps the chart current. */
const HISTORY_REFRESH_MS = 5 * 60_000;
/** Covers the overview's 30-day range and the plan sizing's history. */
const ACTIVITY_DAYS = rangeDays('30d');
/** A burst of requests reloads the hourly activity once, after it settles. */
const ACTIVITY_RELOAD_DEBOUNCE_MS = 2_000;

export async function saveSettings(next: AppSettings): Promise<void> {
  setSettingsSignal(await api.setSettings(next));
}

/** Applies `fn` to a copy of the current settings and saves it. */
export function updateSettings(fn: (draft: AppSettings) => void): Promise<void> {
  const draft = structuredClone(settings());
  fn(draft);
  return saveSettings(draft);
}

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(choice: string): void {
  const theme = resolveTheme(choice, prefersDark.matches);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeTokens(theme))) root.style.setProperty(name, value);
  root.style.colorScheme = theme.scheme;
  root.dataset.theme = theme.id;
}

export async function initStore(): Promise<void> {
  const [s, latest, status, hist, logLines, recent, dark] = await Promise.all([
    api.getSettings(), api.usageLatest(), api.proxyStatus(), api.usageHistory(), api.proxyLogs(), api.activityList(), api.taskbarDark(),
  ]);
  setTaskbarDark(dark);
  setSettingsSignal(s);
  setSnapshot(latest.snapshot);
  setUsageError(latest.error);
  setProxyStatus(status);
  setHistory(hist);
  setLogs(logLines);
  setActivity(recent);
  void api.activityBuckets(ACTIVITY_DAYS).then(setActivityBuckets);

  api.onSnapshot((next) => {
    setSnapshot(next);
    setUsageError(null);
  });
  api.onUsageError(setUsageError);
  api.onProxyStatus(setProxyStatus);
  api.onProxyLog((line) => setLogs((prev) => (prev.length >= MAX_LOG_LINES ? [...prev.slice(1), line] : [...prev, line])));
  api.onMaximized(setMaximized);
  api.onTaskbarDark(setTaskbarDark);
  api.onNavigate((p) => setPage(p as Page));
  api.onSettings(setSettingsSignal);
  let bucketsReload: ReturnType<typeof setTimeout> | undefined;
  api.onActivity((e) => {
    setActivity((prev) => (prev.length >= MAX_ACTIVITY_EVENTS ? [...prev.slice(1), e] : [...prev, e]));
    clearTimeout(bucketsReload);
    bucketsReload = setTimeout(() => void api.activityBuckets(ACTIVITY_DAYS).then(setActivityBuckets), ACTIVITY_RELOAD_DEBOUNCE_MS);
  });

  tickEachMinute();
  setInterval(() => void api.usageHistory().then(setHistory), HISTORY_REFRESH_MS);
  prefersDark.addEventListener('change', () => applyTheme(settings().general.theme));
}

/** Re-aims at the next minute from the wall clock each time, so ticks never drift off it. */
function tickEachMinute(): void {
  setTimeout(() => {
    setNow(Date.now());
    tickEachMinute();
  }, msToNextMinute(Date.now()));
}

export { applyTheme };
