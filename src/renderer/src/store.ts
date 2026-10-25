import { createMemo, createRoot, createSignal } from 'solid-js';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { maskSnapshot } from '@shared/privacy';
import { resolveTheme, themeTokens } from '@shared/themes';
import type { HistorySample, LogLine, ProxyStatus, UsageSnapshot } from '@shared/types';

export type Page = 'dashboard' | 'accounts' | 'proxy' | 'settings';

const api = window.api;

export const [page, setPage] = createSignal<Page>('dashboard');
export const [settings, setSettingsSignal] = createSignal<AppSettings>(DEFAULT_SETTINGS);
const [rawSnapshot, setRawSnapshot] = createSignal<UsageSnapshot | null>(null);
export const setSnapshot = setRawSnapshot;
/** What the UI shows: the latest snapshot, emails masked unless "Show emails" is on. Module-lifetime root. */
export const snapshot = createRoot(() =>
  createMemo(() => {
    const s = rawSnapshot();
    return s && !settings().dashboard.showEmails ? maskSnapshot(s) : s;
  }),
);
export const [usageError, setUsageError] = createSignal<string | null>(null);
export const [history, setHistory] = createSignal<HistorySample[]>([]);
export const [proxyStatus, setProxyStatus] = createSignal<ProxyStatus | null>(null);
export const [logs, setLogs] = createSignal<LogLine[]>([]);
export const [maximized, setMaximized] = createSignal(false);
/** Ticks every 30 s so countdowns re-render without each component owning a timer. */
export const [now, setNow] = createSignal(Date.now());

const CLOCK_TICK_MS = 30_000;
const MAX_LOG_LINES = 2000;
/** History refetch after a snapshot is cheap (local file) and keeps the chart current. */
const HISTORY_REFRESH_MS = 5 * 60_000;

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
  const [s, latest, status, hist, logLines] = await Promise.all([
    api.getSettings(), api.usageLatest(), api.proxyStatus(), api.usageHistory(), api.proxyLogs(),
  ]);
  setSettingsSignal(s);
  setSnapshot(latest.snapshot);
  setUsageError(latest.error);
  setProxyStatus(status);
  setHistory(hist);
  setLogs(logLines);

  api.onSnapshot((next) => {
    setSnapshot(next);
    setUsageError(null);
  });
  api.onUsageError(setUsageError);
  api.onProxyStatus(setProxyStatus);
  api.onProxyLog((line) => setLogs((prev) => (prev.length >= MAX_LOG_LINES ? [...prev.slice(1), line] : [...prev, line])));
  api.onMaximized(setMaximized);
  api.onNavigate((p) => setPage(p as Page));
  api.onSettings(setSettingsSignal);

  setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
  setInterval(() => void api.usageHistory().then(setHistory), HISTORY_REFRESH_MS);
  prefersDark.addEventListener('change', () => applyTheme(settings().general.theme));
}

export { applyTheme };
