/** App settings: shape, defaults and normalization of untrusted stored JSON. */

import { DEFAULT_ACTIVITY_BOARD, normalizeActivityBoard, type ActivityBoard } from './activityBoard';
import { THEME_CHOICES } from './themes';
import { DEFAULT_WINDOW_START, normalizeWindowStart, type WindowStartSettings } from './windowStartSettings';

export type RoutingStrategy = 'soonest-reset' | 'fill-first' | 'round-robin' | 'weighted-round-robin';
/** Whether API keys are routed to before or after subscription logins. */
export type ApiKeyOrder = 'first' | 'last';
/** What a provider server error (overload, 5xx, dropped connection) does: stay on the account or switch to another. */
export type ServerErrorAction = 'stay' | 'switch';
export type TrayIconScope = 'active' | 'pool' | 'lowest' | 'account';
export type TrayIconValue = 'remaining' | 'used';
/** 'none' draws the digits alone. */
export type TrayIconShape = 'square' | 'rounded' | 'circle' | 'none';
export type TrayIconFill = 'outline' | 'filled';

/** How one tray icon is drawn, so icons for different limits look different. */
export interface TrayIconLook {
  shape: TrayIconShape;
  fill: TrayIconFill;
  /** Lowercase #rrggbb; null uses the provider colour. */
  color: string | null;
}

export const DEFAULT_TRAY_LOOK: TrayIconLook = { shape: 'square', fill: 'outline', color: null };

export interface TrayIconSpec {
  id: string;
  provider: string;
  windowKey: string;
  scope: TrayIconScope;
  /** Set when scope is 'account'. */
  credentialId?: string;
  look: TrayIconLook;
}

export interface AppSettings {
  general: {
    launchAtLogin: boolean;
    startMinimized: boolean;
    closeToTray: boolean;
    minimizeToTray: boolean;
    /** 'system' or a theme id from themes.ts. */
    theme: string;
    confirmQuit: boolean;
    /** Sidebar shows icons only. */
    sidebarCollapsed: boolean;
  };
  proxy: {
    autoStart: boolean;
    port: number;
    allowLan: boolean;
    strategy: RoutingStrategy;
    apiKeyOrder: ApiKeyOrder;
    sessionAffinity: boolean;
    sessionAffinityTtlMinutes: number;
    /** Empty = bundled binary. */
    executablePath: string;
    restartOnCrash: boolean;
    serverErrors: ServerErrorAction;
    /** Cancel an upstream stream that sends nothing for this long, then treat it as a server error; 0 = never. */
    firstByteTimeoutSeconds: number;
    /** Proxy writes every request and response, prompts included, to its logs folder. */
    requestLog: boolean;
    /** Tray "Use account" override: provider → auth_index the proxy prefers while it is available. */
    preferredAccounts: Record<string, string>;
  };
  windowStart: WindowStartSettings;
  dashboard: {
    refreshIntervalSeconds: number;
    showEmails: boolean;
    forecastHours: number;
    drainLookbackHours: number;
    accountSort: 'reset' | 'usage' | 'name';
  };
  trayIcons: {
    enabled: boolean;
    value: TrayIconValue;
    warnAtPercentUsed: number;
    criticalAtPercentUsed: number;
    items: TrayIconSpec[];
    /** The colour picker's saved custom colours, shared by every icon. */
    savedColors: string[];
  };
  notifications: {
    limitHit: boolean;
    limitReset: boolean;
    accountSwitched: boolean;
    proxyCrashed: boolean;
  };
  updates: {
    /** Check for a new release at start and periodically; downloading and installing stay manual. */
    autoCheck: boolean;
  };
  activity: {
    /** Days of per-request logs kept on disk; daily totals are kept until cleared. */
    retentionDays: number;
    /** The Overview's chart tiles. */
    board: ActivityBoard;
  };
}

/** Proxy default port, matching upstream config.example.yaml. */
export const DEFAULT_PROXY_PORT = 8317;
const MIN_USER_PORT = 1024;
const MAX_PORT = 65535;
/** Faster polling than this only re-reads the same cached headers. */
const MIN_REFRESH_SECONDS = 15;
const MAX_REFRESH_SECONDS = 3600;
const HOURS_PER_DAY = 24;
/** Two weeks: history keeps 14 days, so a longer forecast outruns its evidence. */
const MAX_FORECAST_HOURS = 14 * HOURS_PER_DAY;
const MAX_LOOKBACK_HOURS = 168;
const MAX_AFFINITY_MINUTES = 24 * 60;
/** Claude streams begin with message_start within seconds; 90 s also covers very long prompts. */
const DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS = 90;
const MAX_FIRST_BYTE_TIMEOUT_SECONDS = 600;
/** A month of requests is a few MB per busy day; a year bounds disk use. */
const DEFAULT_ACTIVITY_RETENTION_DAYS = 30;
const MAX_ACTIVITY_RETENTION_DAYS = 365;

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    launchAtLogin: true,
    startMinimized: true,
    closeToTray: true,
    minimizeToTray: false,
    theme: 'dracula',
    confirmQuit: false,
    sidebarCollapsed: false,
  },
  proxy: {
    autoStart: true,
    port: DEFAULT_PROXY_PORT,
    allowLan: false,
    strategy: 'soonest-reset',
    // Subscriptions are prepaid; API keys bill per request.
    apiKeyOrder: 'last',
    sessionAffinity: true,
    // Upstream default session-affinity-ttl is 1h.
    sessionAffinityTtlMinutes: 60,
    // Every account reaches the same provider servers, so switching on a server error only loses the prompt cache.
    serverErrors: 'stay',
    executablePath: '',
    restartOnCrash: true,
    firstByteTimeoutSeconds: DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS,
    // Off: full request logs hold prompts and grow quickly. Failed requests are logged regardless.
    requestLog: false,
    preferredAccounts: {},
  },
  windowStart: DEFAULT_WINDOW_START,
  dashboard: {
    refreshIntervalSeconds: 60,
    showEmails: false,
    forecastHours: 7 * HOURS_PER_DAY,
    drainLookbackHours: 24,
    accountSort: 'reset',
  },
  trayIcons: {
    enabled: true,
    value: 'remaining',
    warnAtPercentUsed: 75,
    criticalAtPercentUsed: 90,
    items: [
      { id: 'claude-five_hour-active', provider: 'claude', windowKey: 'five_hour', scope: 'active', look: DEFAULT_TRAY_LOOK },
      // A different shape so the two Claude windows are tellable apart out of the box.
      { id: 'claude-seven_day-pool', provider: 'claude', windowKey: 'seven_day', scope: 'pool', look: { ...DEFAULT_TRAY_LOOK, shape: 'circle' } },
    ],
    savedColors: [],
  },
  notifications: {
    limitHit: true,
    limitReset: true,
    accountSwitched: false,
    proxyCrashed: true,
  },
  updates: {
    autoCheck: true,
  },
  activity: {
    retentionDays: DEFAULT_ACTIVITY_RETENTION_DAYS,
    board: DEFAULT_ACTIVITY_BOARD,
  },
};

const STRATEGIES: readonly RoutingStrategy[] = ['soonest-reset', 'fill-first', 'round-robin', 'weighted-round-robin'];
const API_KEY_ORDERS: readonly ApiKeyOrder[] = ['first', 'last'];
const SERVER_ERROR_ACTIONS: readonly ServerErrorAction[] = ['stay', 'switch'];
const SCOPES: readonly TrayIconScope[] = ['active', 'pool', 'lowest', 'account'];
const SORTS = ['reset', 'usage', 'name'] as const;
const SHAPES: readonly TrayIconShape[] = ['square', 'rounded', 'circle', 'none'];
const FILLS: readonly TrayIconFill[] = ['outline', 'filled'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const int = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const hexColor = (v: unknown): string | null => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : null);
const stringRecord = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v)).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));

function normalizeTrayItem(v: unknown): TrayIconSpec | null {
  const o = obj(v);
  if (typeof o.provider !== 'string' || typeof o.windowKey !== 'string' || !o.provider || !o.windowKey) return null;
  const scope = pick(o.scope, SCOPES, 'active');
  if (scope === 'account' && typeof o.credentialId !== 'string') return null;
  const id = typeof o.id === 'string' && o.id ? o.id : `${o.provider}-${o.windowKey}-${scope}`;
  const l = obj(o.look);
  const look: TrayIconLook = {
    shape: pick(l.shape, SHAPES, DEFAULT_TRAY_LOOK.shape),
    fill: pick(l.fill, FILLS, DEFAULT_TRAY_LOOK.fill),
    color: hexColor(l.color),
  };
  return { id, provider: o.provider, windowKey: o.windowKey, scope, ...(scope === 'account' ? { credentialId: o.credentialId as string } : {}), look };
}

/** Rebuilds settings from stored JSON, dropping invalid values for their defaults. */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS;
  const r = obj(raw);
  const g = obj(r.general), p = obj(r.proxy), db = obj(r.dashboard), t = obj(r.trayIcons), n = obj(r.notifications), u = obj(r.updates);
  const a = obj(r.activity);
  const warn = int(t.warnAtPercentUsed, d.trayIcons.warnAtPercentUsed, 1, 99);
  return {
    general: {
      launchAtLogin: bool(g.launchAtLogin, d.general.launchAtLogin),
      startMinimized: bool(g.startMinimized, d.general.startMinimized),
      closeToTray: bool(g.closeToTray, d.general.closeToTray),
      minimizeToTray: bool(g.minimizeToTray, d.general.minimizeToTray),
      theme: pick(g.theme, THEME_CHOICES, d.general.theme),
      confirmQuit: bool(g.confirmQuit, d.general.confirmQuit),
      sidebarCollapsed: bool(g.sidebarCollapsed, d.general.sidebarCollapsed),
    },
    proxy: {
      autoStart: bool(p.autoStart, d.proxy.autoStart),
      port: int(p.port, d.proxy.port, MIN_USER_PORT, MAX_PORT),
      allowLan: bool(p.allowLan, d.proxy.allowLan),
      strategy: pick(p.strategy, STRATEGIES, d.proxy.strategy),
      apiKeyOrder: pick(p.apiKeyOrder, API_KEY_ORDERS, d.proxy.apiKeyOrder),
      sessionAffinity: bool(p.sessionAffinity, d.proxy.sessionAffinity),
      sessionAffinityTtlMinutes: int(p.sessionAffinityTtlMinutes, d.proxy.sessionAffinityTtlMinutes, 1, MAX_AFFINITY_MINUTES),
      serverErrors: pick(p.serverErrors, SERVER_ERROR_ACTIONS, d.proxy.serverErrors),
      executablePath: str(p.executablePath, d.proxy.executablePath),
      restartOnCrash: bool(p.restartOnCrash, d.proxy.restartOnCrash),
      firstByteTimeoutSeconds: int(p.firstByteTimeoutSeconds, d.proxy.firstByteTimeoutSeconds, 0, MAX_FIRST_BYTE_TIMEOUT_SECONDS),
      requestLog: bool(p.requestLog, d.proxy.requestLog),
      preferredAccounts: stringRecord(p.preferredAccounts),
    },
    windowStart: normalizeWindowStart(r.windowStart),
    dashboard: {
      refreshIntervalSeconds: int(db.refreshIntervalSeconds, d.dashboard.refreshIntervalSeconds, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS),
      showEmails: bool(db.showEmails, d.dashboard.showEmails),
      // Older settings stored whole days as `forecastDays`.
      forecastHours: int(db.forecastHours ?? (typeof db.forecastDays === 'number' ? db.forecastDays * HOURS_PER_DAY : undefined), d.dashboard.forecastHours, 1, MAX_FORECAST_HOURS),
      drainLookbackHours: int(db.drainLookbackHours, d.dashboard.drainLookbackHours, 1, MAX_LOOKBACK_HOURS),
      accountSort: pick(db.accountSort, SORTS, d.dashboard.accountSort),
    },
    trayIcons: {
      enabled: bool(t.enabled, d.trayIcons.enabled),
      value: pick(t.value, ['remaining', 'used'] as const, d.trayIcons.value),
      warnAtPercentUsed: warn,
      criticalAtPercentUsed: int(t.criticalAtPercentUsed, d.trayIcons.criticalAtPercentUsed, warn + 1, 100),
      items: Array.isArray(t.items)
        ? t.items.map(normalizeTrayItem).filter((i): i is TrayIconSpec => i !== null)
        : d.trayIcons.items,
      savedColors: Array.isArray(t.savedColors) ? t.savedColors.map(hexColor).filter((c): c is string => c !== null) : [],
    },
    notifications: {
      limitHit: bool(n.limitHit, d.notifications.limitHit),
      limitReset: bool(n.limitReset, d.notifications.limitReset),
      accountSwitched: bool(n.accountSwitched, d.notifications.accountSwitched),
      proxyCrashed: bool(n.proxyCrashed, d.notifications.proxyCrashed),
    },
    updates: {
      autoCheck: bool(u.autoCheck, d.updates.autoCheck),
    },
    activity: {
      retentionDays: int(a.retentionDays, d.activity.retentionDays, 1, MAX_ACTIVITY_RETENTION_DAYS),
      board: normalizeActivityBoard(a.board),
    },
  };
}

/** Settings written to config.yaml that a running proxy reloads live. */
export function proxyConfigChanged(a: AppSettings, b: AppSettings): boolean {
  return a.proxy.strategy !== b.proxy.strategy || a.proxy.apiKeyOrder !== b.proxy.apiKeyOrder || a.proxy.sessionAffinity !== b.proxy.sessionAffinity ||
    a.proxy.sessionAffinityTtlMinutes !== b.proxy.sessionAffinityTtlMinutes || a.proxy.firstByteTimeoutSeconds !== b.proxy.firstByteTimeoutSeconds ||
    a.proxy.serverErrors !== b.proxy.serverErrors || a.proxy.requestLog !== b.proxy.requestLog;
}

/** Settings whose change requires the proxy to be restarted to take effect. */
export function proxyRestartNeeded(a: AppSettings, b: AppSettings): boolean {
  return a.proxy.port !== b.proxy.port || a.proxy.allowLan !== b.proxy.allowLan || a.proxy.executablePath !== b.proxy.executablePath;
}
