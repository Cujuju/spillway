import { createComputed, createRoot, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { maskSnapshot } from '@shared/privacy';
import { rollPastResets } from '@shared/usageWindows';
import { msToNextMinute } from '@shared/resetTime';
import { resolveTheme, themeTokens } from '@shared/themes';
import { rangeDays } from './lib/activityStats';
import { persistedSignal } from './lib/persisted';
import type { ActivityBucket, HistorySample, LogLine, ProxyStatus, UsageSnapshot } from '@shared/types';

const PAGES = ['dashboard', 'activity', 'providers', 'proxy', 'logs', 'settings'] as const;
export type Page = (typeof PAGES)[number];

const api = window.api;

export const [page, setPage] = persistedSignal<Page>('page', 'dashboard', PAGES);

const SETTINGS_SECTIONS = ['general', 'appearance', 'trayIcons', 'proxy', 'windowStart', 'dashboard', 'notifications', 'updates', 'advanced'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
/** Lives here, not in the Settings page, so other views can open a section directly. */
export const [settingsSection, setSettingsSection] = persistedSignal<SettingsSection>('settingsSection', 'general', SETTINGS_SECTIONS);
export function openSettings(section: SettingsSection): void {
  setSettingsSection(section);
  setPage('settings');
}
/**
 * State from main that lists render, diffed in by `id` so unchanged objects keep identity and `<For>`
 * keeps rows' local state. Read-only; `unwrap` before cloning or IPC.
 */
function createReconciled<T>(initial: T): [get: () => T, set: (next: T) => void] {
  const [state, setState] = createStore({ value: initial });
  // The getter is an accessor: callers read it inside their own tracked scopes.
  // oxlint-disable-next-line solid/reactivity
  return [() => state.value, (next) => setState('value', reconcile(next, { key: 'id' }))];
}

export const [settings, setSettingsSignal] = createReconciled<AppSettings>(DEFAULT_SETTINGS);
/** Ticks on each wall-clock minute so countdowns re-render without each component owning a timer. */
export const [now, setNow] = createSignal(Date.now());
const [rawSnapshot, setRawSnapshot] = createSignal<UsageSnapshot | null>(null);
export const setSnapshot = setRawSnapshot;
const [shownSnapshot, setShownSnapshot] = createReconciled<UsageSnapshot | null>(null);
createRoot(() =>
  createComputed(() => {
    const raw = rawSnapshot();
    const s = raw && rollPastResets(raw, now());
    setShownSnapshot(s && !settings().dashboard.showEmails ? maskSnapshot(s) : s);
  }),
);
/**
 * What the UI shows: the latest snapshot with windows past their reset rolled to zero, emails masked
 * unless "Show emails" is on.
 */
export const snapshot = shownSnapshot;
export const [usageError, setUsageError] = createSignal<string | null>(null);
export const [history, setHistory] = createSignal<HistorySample[]>([]);
export const [proxyStatus, setProxyStatus] = createSignal<ProxyStatus | null>(null);
export const [logs, setLogs] = createSignal<LogLine[]>([]);
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
  // Edits can copy store-backed values into the draft; IPC cannot clone Solid proxies.
  setSettingsSignal(await api.setSettings(unwrap(next)));
}

/** Applies `fn` to a copy of the current settings and saves it. */
export function updateSettings(fn: (draft: AppSettings) => void): Promise<void> {
  const draft = structuredClone(unwrap(settings()));
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
  const [s, latest, status, hist, logLines, dark] = await Promise.all([
    api.getSettings(), api.usageLatest(), api.proxyStatus(), api.usageHistory(), api.proxyLogs(), api.taskbarDark(),
  ]);
  setTaskbarDark(dark);
  setSettingsSignal(s);
  setSnapshot(latest.snapshot);
  setUsageError(latest.error);
  setProxyStatus(status);
  setHistory(hist);
  setLogs(logLines);
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
  api.onActivity(() => {
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
