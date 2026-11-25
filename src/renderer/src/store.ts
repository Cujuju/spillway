import type { ActivityImportState, ArchiveMigrationState } from '@shared/ipc';
import { batch, createComputed, createRoot, createSignal, untrack } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { maskEmails, maskSnapshot } from '@shared/privacy';
import { rollPastResets } from '@shared/usageWindows';
import { msToNextMinute } from '@shared/resetTime';
import { resolveTheme, THEMES, type Theme } from '@shared/themes';
import { paintTheme } from './lib/theme';
import { persistedSignal } from './lib/persisted';
import { createActivityReload } from './lib/activityReload';
import { localHourStart } from './lib/rhythmProfile';
import { installCatalogPrices, type PriceCatalogInfo, type PriceCatalogState } from '@shared/modelPrices';
import type { ActivityBucket, HistorySample, LogLine, ObservedSpan, ProxyStatus, UsageSnapshot, WindowSummary } from '@shared/types';

const PAGES = ['dashboard', 'activity', 'providers', 'proxy', 'logs', 'settings', 'help'] as const;
export type Page = (typeof PAGES)[number];

const api = window.api;

export const [page, setPage] = persistedSignal<Page>('page', 'dashboard', PAGES);

const SETTINGS_SECTIONS = ['general', 'appearance', 'notifications', 'startup', 'proxy', 'windowStart', 'dashboard', 'updates', 'capture', 'storage', 'clickhouse', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
/** Retired section ids still in saved state, mapped to the section that now holds their settings. */
const RETIRED_SECTIONS = { advanced: 'storage', window: 'general', trayIcons: 'general' } as const satisfies Record<string, SettingsSection>;
type RetiredSection = keyof typeof RETIRED_SECTIONS;
const isRetired = (s: string): s is RetiredSection => Object.hasOwn(RETIRED_SECTIONS, s);
/** Lives here, not in the Settings page, so other views can open a section directly. */
const [storedSection, setStoredSection] = persistedSignal<SettingsSection | RetiredSection>('settingsSection', 'general', [...SETTINGS_SECTIONS, ...(Object.keys(RETIRED_SECTIONS) as RetiredSection[])]);
export const settingsSection = (): SettingsSection => {
  const section = storedSection();
  return isRetired(section) ? RETIRED_SECTIONS[section] : section;
};
export const setSettingsSection = (section: SettingsSection) => setStoredSection(section);
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
/** Free text that may hold an email (errors, stored notices), masked on read so toggling "Show emails" applies. */
export const shownText = (text: string): string => (settings().dashboard.showEmails ? text : maskEmails(text));
/**
 * What the UI shows: the latest snapshot with windows past their reset rolled to zero, emails masked
 * unless "Show emails" is on.
 */
export const snapshot = shownSnapshot;
export const [usageError, setUsageError] = createSignal<string | null>(null);
export const [history, setHistory] = createSignal<HistorySample[]>([]);
export const [windowSummaries, setWindowSummaries] = createSignal<WindowSummary[]>([]);
export const [observedSpans, setObservedSpans] = createSignal<ObservedSpan[]>([]);
export const [proxyStatus, setProxyStatus] = createSignal<ProxyStatus | null>(null);
export const [logs, setLogs] = createSignal<LogLine[]>([]);
/** Hourly activity for the Activity overview and plan sizing (poolCapacity). */
export const [activityBuckets, setActivityBuckets] = createSignal<ActivityBucket[]>([]);
/** Fixed forecast evidence, independent of the Activity page's chosen range. */
export const [forecastBuckets, setForecastBuckets] = createSignal<ActivityBucket[]>([]);
/** Snapshot timestamp for `forecastBuckets`, bounding measured session sizing so 5-minute history refreshes do not drift ahead of frozen costs. */
export const [forecastAsOf, setForecastAsOf] = createSignal(Infinity);
export const [activityImport, setActivityImport] = createSignal<ActivityImportState>({ state: 'idle', filesDone: 0, filesTotal: 0, recordsImported: 0, error: null });
/** One-time re-encoding of recorded bodies; the Activity worker answers nothing else meanwhile. */
export const [archiveMigration, setArchiveMigration] = createSignal<ArchiveMigrationState>({ state: 'idle', done: 0, total: 0 });
export const [maximized, setMaximized] = createSignal(false);
export const [taskbarDark, setTaskbarDark] = createSignal(true);
export const [priceCatalogInfo, setPriceCatalogInfo] = createSignal<PriceCatalogInfo>({ fetchedAt: null, models: 0 });
const applyPriceCatalog = (state: PriceCatalogState) => { installCatalogPrices(state.prices); setPriceCatalogInfo(state.info); };

const MAX_LOG_LINES = 2000;
/** History refetch after a snapshot is cheap (local file) and keeps the chart current. */
const HISTORY_REFRESH_MS = 5 * 60_000;
/** Plan sizing (poolCapacity) and the account lists read recent history; they have always had 31 local days. */
const MIN_ACTIVITY_DAYS = 31;
/** Local days of activity held; null holds all. The Activity page widens it to its time frame. */
const [activityDays, setActivityDays] = createSignal<number | null>(MIN_ACTIVITY_DAYS);
let activityGeneration = 0;
let activityRequest = 0;
let activityAppliedRequest = 0;
let forecastDirty = true;
let forecastDirtyRequest = 0;
let lastForecastHour: number | undefined;
let pendingForecastHour: number | undefined;
const loadActivity = (wantsForecast: boolean) => {
  const requestedAt = Date.now();
  const requestHour = localHourStart(requestedAt);
  const generation = activityGeneration;
  const request = ++activityRequest;
  if (wantsForecast) {
    forecastDirty = true;
    forecastDirtyRequest = request;
    pendingForecastHour = requestHour;
  }
  void api.activityBucketSnapshot(untrack(activityDays)).then(({ held, forecast }) => {
    if (generation !== activityGeneration || request < activityAppliedRequest) return;
    activityAppliedRequest = request;
    if (wantsForecast || (forecastDirty && request >= forecastDirtyRequest)) {
      if (request >= forecastDirtyRequest) forecastDirty = false;
      lastForecastHour = requestHour;
      if (pendingForecastHour === requestHour) pendingForecastHour = undefined;
      batch(() => {
        setActivityBuckets(held);
        setForecastBuckets(forecast);
        setForecastAsOf(requestHour);
      });
    } else {
      setActivityBuckets(held);
    }
  }).catch((err: unknown) => {
    if (request === forecastDirtyRequest) pendingForecastHour = undefined;
    console.error('[activity] aggregates failed to load:', err);
  });
};

/** Holds at least `days` local days of activity (null: all), reloading when that widens or narrows. */
export function holdActivityDays(days: number | null): void {
  const next = days === null ? null : Math.max(MIN_ACTIVITY_DAYS, days);
  if (next === activityDays()) return;
  activityGeneration++;
  setActivityDays(next);
  loadActivity(true);
}
async function saveSettings(next: AppSettings): Promise<void> {
  // Edits can copy store-backed values into the draft; IPC cannot clone Solid proxies.
  setSettingsSignal(await api.setSettings(unwrap(next)));
}

/** Why the last settings save failed; cleared by the next one that succeeds. The app shell shows it. */
export const [settingsError, setSettingsError] = createSignal<string | null>(null);

/** Applies `fn` to a copy of the current settings and saves it. Never rejects: a failure lands in `settingsError`. */
export async function updateSettings(fn: (draft: AppSettings) => void): Promise<void> {
  try {
    const draft = structuredClone(unwrap(settings()));
    fn(draft);
    await saveSettings(draft);
    setSettingsError(null);
  } catch (e) {
    setSettingsError(e instanceof Error ? e.message : String(e));
  }
}

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
/** The applied theme, resolved from the setting and the OS preference. */
export const [activeTheme, setActiveTheme] = createSignal<Theme>(THEMES[0]!);

function applyTheme(choice: string): void {
  const theme = resolveTheme(choice, prefersDark.matches);
  paintTheme(document.documentElement, theme);
  setActiveTheme(theme);
}

export async function initStore(): Promise<void> {
  // Before any await: main sends this once the page loads, which can beat the startup reads below.
  api.onOpenSettings((s) => (SETTINGS_SECTIONS as readonly string[]).includes(s) ? openSettings(s as SettingsSection) : setPage('settings'));
  api.onOpenProxy(() => setPage('proxy'));
  // Before the startup read, so a catalog download finishing meanwhile is not lost.
  let receivedCatalogEvent = false;
  let reloadActivity: (() => void) | undefined;
  api.onPriceCatalog((state) => { receivedCatalogEvent = true; applyPriceCatalog(state); reloadActivity?.(); });
  let receivedImportEvent = false;
  api.onActivityImport((state) => { receivedImportEvent = true; setActivityImport(state); });
  let receivedMigrationEvent = false;
  api.onArchiveMigration((state) => { receivedMigrationEvent = true; setArchiveMigration(state); });
  const [initialImport, initialMigration, initialCatalog] = await Promise.all([api.activityImportState(), api.archiveMigrationState(), api.priceCatalog()]);
  if (!receivedCatalogEvent) applyPriceCatalog(initialCatalog);
  if (!receivedImportEvent) setActivityImport(initialImport);
  if (!receivedMigrationEvent) setArchiveMigration(initialMigration);  const [s, latest, status, hist, summaries, spans, logLines, dark] = await Promise.all([
    api.getSettings(), api.usageLatest(), api.proxyStatus(), api.usageHistory(), api.usageWindowSummaries(), api.usageObservedSpans(), api.proxyLogs(), api.taskbarDark(),
  ]);
  setTaskbarDark(dark);
  setSettingsSignal(s);
  setSnapshot(latest.snapshot);
  setUsageError(latest.error);
  setProxyStatus(status);
  setHistory(hist);
  setWindowSummaries(summaries);
  setObservedSpans(spans);
  setLogs(logLines);
  const bucketsReload = createActivityReload(() => loadActivity(false));
  reloadActivity = () => { activityGeneration++; bucketsReload.cancel(); loadActivity(true); };
  reloadActivity();
  api.onActivityReset(reloadActivity);

  api.onSnapshot((next) => {
    setSnapshot(next);
    setUsageError(null);
  });
  api.onUsageError(setUsageError);
  api.onProxyStatus(setProxyStatus);
  api.onProxyLog((line) => setLogs((prev) => (prev.length >= MAX_LOG_LINES ? [...prev.slice(1), line] : [...prev, line])));
  api.onMaximized(setMaximized);
  api.onTaskbarDark(setTaskbarDark);
  api.onSettings(setSettingsSignal);
  api.onActivity(bucketsReload.schedule);

  tickEachMinute();
  setInterval(() => {
    void api.usageHistory().then(setHistory);
    void api.usageWindowSummaries().then(setWindowSummaries);
    void api.usageObservedSpans().then(setObservedSpans);
  }, HISTORY_REFRESH_MS);
  prefersDark.addEventListener('change', () => applyTheme(settings().general.theme));
}

/** Re-aims at the next minute from the wall clock each time, so ticks never drift off it. */
function tickEachMinute(): void {
  setTimeout(() => {
    const nextNow = Date.now();
    setNow(nextNow);
    const hour = localHourStart(nextNow);
    if (hour !== lastForecastHour && hour !== pendingForecastHour) loadActivity(true);
    tickEachMinute();
  }, msToNextMinute(Date.now()));
}

export { applyTheme };
