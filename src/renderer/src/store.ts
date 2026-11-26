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
import { localHourStart } from './lib/rhythmProfile';
import { installCatalogPrices, type PriceCatalogInfo, type PriceCatalogState } from '@shared/modelPrices';
import type { ActivityBucket, ActivityBucketDelta, HistorySample, LogLine, ObservedSpan, ProxyStatus, UsageSnapshot, WindowSummary } from '@shared/types';

const PAGES = ['dashboard', 'activity', 'providers', 'proxy', 'logs', 'settings', 'help'] as const;
export type Page = (typeof PAGES)[number];

const api = window.api;

export type StoreStartup = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };
const [storeStartup, setStoreStartup] = createSignal<StoreStartup>({ status: 'loading' });
export { storeStartup };

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
const [logs, replaceLogs] = createSignal<LogLine[]>([]);
export { logs };
/** Hourly activity for the Activity overview and plan sizing (poolCapacity). */
export const [activityBuckets, setActivityBuckets] = createSignal<ActivityBucket[]>([]);
export const [liveActivityVersion, setLiveActivityVersion] = createSignal(0);
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

const isDocumentHidden = () => typeof document !== 'undefined' && document.hidden;
const MAX_LOG_LINES = 2_000;
let pendingLogs: LogLine[] = [];
let nextPendingLog = 0;
let scheduledLogFlush: { frame?: number } | undefined;

function cancelLogFlush(): void {
  const frame = scheduledLogFlush?.frame;
  scheduledLogFlush = undefined;
  if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
}

export const setLogs: typeof replaceLogs = <U extends LogLine[]>(next: Exclude<U, Function> | ((prev: LogLine[]) => U)): U => {
  cancelLogFlush();
  pendingLogs = [];
  nextPendingLog = 0;
  return replaceLogs<U>(next);
};

function flushPendingLogs(): void {
  if (!pendingLogs.length) return;
  const pending = pendingLogs;
  const oldest = pending.length === MAX_LOG_LINES ? nextPendingLog : 0;
  pendingLogs = [];
  nextPendingLog = 0;
  replaceLogs((previous) => {
    const keepFrom = Math.max(0, previous.length + pending.length - MAX_LOG_LINES);
    return [...previous.slice(keepFrom), ...pending.slice(oldest), ...pending.slice(0, oldest)];
  });
}

function enqueueProxyLog(line: LogLine): void {
  pendingLogs[nextPendingLog] = line;
  nextPendingLog = (nextPendingLog + 1) % MAX_LOG_LINES;
  if (scheduledLogFlush || isDocumentHidden()) return;
  const scheduled: { frame?: number } = {};
  scheduledLogFlush = scheduled;
  const flush = () => {
    if (scheduledLogFlush !== scheduled) return;
    scheduledLogFlush = undefined;
    if (!isDocumentHidden()) flushPendingLogs();
  };
  if (typeof requestAnimationFrame === 'function') scheduled.frame = requestAnimationFrame(flush);
  else queueMicrotask(flush);
}

/** History refetch after a snapshot is cheap (local file) and keeps the chart current. */
const HISTORY_REFRESH_MS = 5 * 60_000;
/** Plan sizing (poolCapacity) and the account lists read recent history; they have always had 31 local days. */
const MIN_ACTIVITY_DAYS = 31;
/** Local days of activity held; null holds all. The Activity page widens it to its time frame. */
const [activityDays, setActivityDays] = createSignal<number | null>(MIN_ACTIVITY_DAYS);
/** Bounds buffered deltas during a slow snapshot; overflow falls back to a clean resync. */
const MAX_PENDING_BUCKET_DELTAS = 256;
/** Bounded backoff when an active bucket snapshot fails. */
const BUCKET_RETRY_INITIAL_MS = 2_000;
const BUCKET_RETRY_MAX_MS = 30_000;
const canMergeLiveBuckets = () => bucketSubscribers > 0 && !isDocumentHidden();
const bucketKey = (b: ActivityBucket) => JSON.stringify([b.wholeDay, b.start, b.provider, b.authIndex, b.model, b.client, b.source ?? 'proxy', b.effectiveModel ?? null, b.reasoningEffort ?? null]);
let storeInitialized = false;
let bucketSubscribers = 0;
let activityDirty = true;
let dirtiedDuringLoad = false;
let activityWatermark = 0;
let activityRequest = 0;
let activityLoading = false;
let pendingDeltas: ActivityBucketDelta[] = [];
const bucketIndices = new Map<string, number>();
let forecastDirty = true;
let forecastDirtiedDuringLoad = false;
let lastForecastHour: number | undefined;
let pendingForecastHour: number | undefined;
let bucketRetryTimer: ReturnType<typeof setTimeout> | undefined;
let bucketRetryDelay = 0;

function clearBucketRetry(): void {
  clearTimeout(bucketRetryTimer);
  bucketRetryTimer = undefined;
}

function scheduleBucketRetry(): void {
  if (bucketRetryTimer || activityLoading || isDocumentHidden()) return;
  if (bucketSubscribers === 0 && !forecastDirty) return;
  bucketRetryDelay = bucketRetryDelay ? Math.min(bucketRetryDelay * 2, BUCKET_RETRY_MAX_MS) : BUCKET_RETRY_INITIAL_MS;
  bucketRetryTimer = setTimeout(() => {
    bucketRetryTimer = undefined;
    if (isDocumentHidden() || activityLoading) return;
    if (bucketSubscribers === 0 && !forecastDirty) return;
    loadActivity(forecastDirty || localHourStart(Date.now()) !== lastForecastHour);
  }, bucketRetryDelay);
}

function mergeBucketDeltas(held: ActivityBucket[], deltas: ActivityBucketDelta[]): ActivityBucket[] {
  const days = untrack(activityDays);
  const today = new Date();
  const cutoff = days === null ? -Infinity : new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1).getTime();
  let next = held;
  for (const delta of deltas) {
    if (delta.watermark <= activityWatermark) continue;
    activityWatermark = delta.watermark;
    for (const bucket of delta.buckets) {
      if (bucket.start < cutoff) continue;
      if (next === held) next = held.slice();
      const key = bucketKey(bucket);
      const index = bucketIndices.get(key) ?? next.length;
      bucketIndices.set(key, index);
      next[index] = bucket;
    }
  }
  return next;
}

const loadActivity = (wantsForecast: boolean, forceHeld = false) => {
  clearBucketRetry();
  const includeHeld = forceHeld || canMergeLiveBuckets();
  const requestHour = localHourStart(Date.now());
  const request = ++activityRequest;
  activityLoading = true;
  dirtiedDuringLoad = false;
  forecastDirtiedDuringLoad = false;
  pendingDeltas = [];
  forecastDirty ||= wantsForecast;
  if (forecastDirty) pendingForecastHour = requestHour;
  void api.activityBucketSnapshot(untrack(activityDays), includeHeld).then(({ held, forecast, watermark }) => {
    if (request !== activityRequest) return;
    bucketRetryDelay = 0;
    let nextHeld: ActivityBucket[] | undefined;
    if (includeHeld) {
      activityWatermark = watermark;
      bucketIndices.clear();
      held.forEach((bucket, index) => bucketIndices.set(bucketKey(bucket), index));
      const canReplay = canMergeLiveBuckets();
      if (!canReplay && pendingDeltas.length) dirtiedDuringLoad = true;
      nextHeld = canReplay ? mergeBucketDeltas(held, pendingDeltas) : held;
      activityDirty = dirtiedDuringLoad;
    } else {
      activityDirty = true;
    }
    pendingDeltas = [];
    activityLoading = false;
    batch(() => {
      if (nextHeld) setActivityBuckets(nextHeld);
      if (forecastDirty) {
        forecastDirty = forecastDirtiedDuringLoad;
        if (!forecastDirty) lastForecastHour = requestHour;
        pendingForecastHour = undefined;
        setForecastBuckets(forecast);
        setForecastAsOf(requestHour);
      }
    });
    if (activityDirty && canMergeLiveBuckets()) loadActivity(forecastDirty);
  }).catch((err: unknown) => {
    if (request !== activityRequest) return;
    activityLoading = false;
    activityDirty = true;
    pendingDeltas = [];
    pendingForecastHour = undefined;
    console.error('[activity] aggregates failed to load:', err);
    scheduleBucketRetry();
  });
};

function receiveBucketDelta(delta: ActivityBucketDelta): void {
  if (!canMergeLiveBuckets()) {
    activityDirty = dirtiedDuringLoad = true;
    return;
  }
  if (activityLoading) {
    if (dirtiedDuringLoad) return;
    if (pendingDeltas.length < MAX_PENDING_BUCKET_DELTAS) pendingDeltas.push(delta);
    else {
      pendingDeltas = [];
      activityDirty = dirtiedDuringLoad = true;
    }
    return;
  }
  if (activityDirty) {
    scheduleBucketRetry();
    return;
  }
  setActivityBuckets((held) => mergeBucketDeltas(held, [delta]));
}

export function subscribeActivityBuckets(): () => void {
  if (++bucketSubscribers === 1) {
    queueMicrotask(() => {
      if (bucketSubscribers > 0 && !isDocumentHidden() && activityDirty && !activityLoading) {
        loadActivity(forecastDirty || localHourStart(Date.now()) !== lastForecastHour);
      }
    });
  }
  return () => {
    bucketSubscribers--;
    if (bucketSubscribers === 0 && !forecastDirty) clearBucketRetry();
  };
}

/** Holds at least `days` local days of activity (null: all), reloading when that widens or narrows. */
export function holdActivityDays(days: number | null): void {
  const next = days === null ? null : Math.max(MIN_ACTIVITY_DAYS, days);
  if (next === activityDays()) return;
  setActivityDays(next);
  loadActivity(true, true);
}

// Resets while unsubscribed defer forecast refreshes until returning to dashboard, reveal, or hourly rollover.
createRoot(() => createComputed(() => {
  if (page() === 'dashboard' && storeInitialized && !isDocumentHidden() && forecastDirty && !activityLoading) {
    loadActivity(true);
  }
}));
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

let stopProxyLog: (() => void) | undefined;
let visibilityDocument: Document | undefined;

function onVisibilityChange(): void {
  cancelLogFlush();
  if (isDocumentHidden()) {
    clearBucketRetry();
    return;
  }
  flushPendingLogs();
  const wantsForecast = forecastDirty || localHourStart(Date.now()) !== lastForecastHour;
  if ((activityDirty && canMergeLiveBuckets()) || wantsForecast) loadActivity(wantsForecast);
}

let receivedCatalogEvent = false;
let receivedImportEvent = false;
let receivedMigrationEvent = false;
let reloadActivity: (() => void) | undefined;

function reportStartupError(err: unknown): void {
  console.error('[store] startup failed:', err);
  setStoreStartup({ status: 'error', message: err instanceof Error ? err.message : String(err) });
}

export async function initStore(): Promise<void> {
  setStoreStartup({ status: 'loading' });
  receivedCatalogEvent = receivedImportEvent = receivedMigrationEvent = false;
  reloadActivity = undefined;
  try {
    // Main can send navigation events before the startup reads finish.
    api.onOpenSettings((s) => (SETTINGS_SECTIONS as readonly string[]).includes(s) ? openSettings(s as SettingsSection) : setPage('settings'));
    api.onOpenProxy(() => setPage('proxy'));
    // The startup failure view has a title bar too.
    api.onMaximized(setMaximized);
    // Register before reading so an event during startup or retry wins over the read.
    api.onPriceCatalog((state) => { receivedCatalogEvent = true; applyPriceCatalog(state); reloadActivity?.(); });
    api.onActivityImport((state) => { receivedImportEvent = true; setActivityImport(state); });
    api.onArchiveMigration((state) => { receivedMigrationEvent = true; setArchiveMigration(state); });
    await runStartup();
  } catch (err) {
    reportStartupError(err);
  }
}

export async function retryStartup(): Promise<void> {
  if (storeStartup().status !== 'error') return;
  setStoreStartup({ status: 'loading' });
  await runStartup().catch(reportStartupError);
}

async function runStartup(): Promise<void> {
  const [initialImport, initialMigration, initialCatalog] = await Promise.all([api.activityImportState(), api.archiveMigrationState(), api.priceCatalog()]);
  const [s, latest, status, hist, summaries, spans, logLines, dark] = await Promise.all([
    api.getSettings(), api.usageLatest(), api.proxyStatus(), api.usageHistory(), api.usageWindowSummaries(), api.usageObservedSpans(), api.proxyLogs(), api.taskbarDark(),
  ]);
  if (!receivedCatalogEvent) applyPriceCatalog(initialCatalog);
  if (!receivedImportEvent) setActivityImport(initialImport);
  if (!receivedMigrationEvent) setArchiveMigration(initialMigration);
  setTaskbarDark(dark);
  setSettingsSignal(s);
  setSnapshot(latest.snapshot);
  setUsageError(latest.error);
  setProxyStatus(status);
  setHistory(hist);
  setWindowSummaries(summaries);
  setObservedSpans(spans);
  setLogs(logLines);
  storeInitialized = true;
  reloadActivity = () => loadActivity(true);
  reloadActivity();
  api.onActivityReset(() => {
    setLiveActivityVersion((version) => version + 1);
    if (!canMergeLiveBuckets()) {
      activityDirty = dirtiedDuringLoad = forecastDirty = forecastDirtiedDuringLoad = true;
      return;
    }
    loadActivity(true);
  });
  api.onActivityBuckets(receiveBucketDelta);
  if (typeof document !== 'undefined' && visibilityDocument !== document) {
    visibilityDocument?.removeEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    visibilityDocument = document;
  }

  api.onSnapshot((next) => {
    setSnapshot(next);
    setUsageError(null);
  });
  api.onUsageError(setUsageError);
  api.onProxyStatus(setProxyStatus);
  stopProxyLog?.();
  stopProxyLog = api.onProxyLog(enqueueProxyLog);
  api.onTaskbarDark(setTaskbarDark);
  api.onSettings(setSettingsSignal);
  api.onActivity(() => { setLiveActivityVersion((version) => version + 1); });

  tickEachMinute();
  setInterval(() => {
    void api.usageHistory().then(setHistory);
    void api.usageWindowSummaries().then(setWindowSummaries);
    void api.usageObservedSpans().then(setObservedSpans);
  }, HISTORY_REFRESH_MS);
  prefersDark.addEventListener('change', () => applyTheme(settings().general.theme));
  setStoreStartup({ status: 'ready' });
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
