/** App settings: shape, defaults and normalization of untrusted stored JSON. */

import { THEME_CHOICES } from './themes';

export type RoutingStrategy = 'soonest-reset' | 'fill-first' | 'round-robin' | 'weighted-round-robin';
export type TrayIconScope = 'active' | 'pool' | 'lowest' | 'account';
export type TrayIconValue = 'remaining' | 'used';

export interface TrayIconSpec {
  id: string;
  provider: string;
  windowKey: string;
  scope: TrayIconScope;
  /** Set when scope is 'account'. */
  credentialId?: string;
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
  };
  proxy: {
    autoStart: boolean;
    port: number;
    allowLan: boolean;
    strategy: RoutingStrategy;
    sessionAffinity: boolean;
    sessionAffinityTtlMinutes: number;
    /** Empty = bundled binary. */
    executablePath: string;
    restartOnCrash: boolean;
    /** Fail over when an upstream stream sends nothing for this long; 0 = never. */
    firstByteTimeoutSeconds: number;
    /** Tray "Use account" override: provider → auth_index the proxy prefers while it is available. */
    preferredAccounts: Record<string, string>;
  };
  dashboard: {
    refreshIntervalSeconds: number;
    showEmails: boolean;
    forecastDays: number;
    drainLookbackHours: number;
    accountSort: 'reset' | 'usage' | 'name';
  };
  trayIcons: {
    enabled: boolean;
    value: TrayIconValue;
    warnAtPercentUsed: number;
    criticalAtPercentUsed: number;
    items: TrayIconSpec[];
  };
  notifications: {
    limitHit: boolean;
    limitReset: boolean;
    accountSwitched: boolean;
    proxyCrashed: boolean;
  };
}

/** Proxy default port, matching upstream config.example.yaml. */
export const DEFAULT_PROXY_PORT = 8317;
const MIN_USER_PORT = 1024;
const MAX_PORT = 65535;
/** Faster polling than this only re-reads the same cached headers. */
const MIN_REFRESH_SECONDS = 15;
const MAX_REFRESH_SECONDS = 3600;
const MAX_FORECAST_DAYS = 14;
const MAX_LOOKBACK_HOURS = 168;
const MAX_AFFINITY_MINUTES = 24 * 60;
/** Claude streams begin with message_start within seconds; 90 s also covers very long prompts. */
const DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS = 90;
const MAX_FIRST_BYTE_TIMEOUT_SECONDS = 600;

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    launchAtLogin: true,
    startMinimized: true,
    closeToTray: true,
    minimizeToTray: false,
    theme: 'dark',
    confirmQuit: false,
  },
  proxy: {
    autoStart: true,
    port: DEFAULT_PROXY_PORT,
    allowLan: false,
    strategy: 'soonest-reset',
    sessionAffinity: true,
    // Upstream default session-affinity-ttl is 1h.
    sessionAffinityTtlMinutes: 60,
    executablePath: '',
    restartOnCrash: true,
    firstByteTimeoutSeconds: DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS,
    preferredAccounts: {},
  },
  dashboard: {
    refreshIntervalSeconds: 60,
    showEmails: false,
    forecastDays: 7,
    drainLookbackHours: 24,
    accountSort: 'reset',
  },
  trayIcons: {
    enabled: true,
    value: 'remaining',
    warnAtPercentUsed: 75,
    criticalAtPercentUsed: 90,
    items: [
      { id: 'claude-five_hour-active', provider: 'claude', windowKey: 'five_hour', scope: 'active' },
      { id: 'claude-seven_day-pool', provider: 'claude', windowKey: 'seven_day', scope: 'pool' },
    ],
  },
  notifications: {
    limitHit: true,
    limitReset: true,
    accountSwitched: false,
    proxyCrashed: true,
  },
};

const STRATEGIES: readonly RoutingStrategy[] = ['soonest-reset', 'fill-first', 'round-robin', 'weighted-round-robin'];
const SCOPES: readonly TrayIconScope[] = ['active', 'pool', 'lowest', 'account'];
const SORTS = ['reset', 'usage', 'name'] as const;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const int = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const stringRecord = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v)).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));

function normalizeTrayItem(v: unknown): TrayIconSpec | null {
  const o = obj(v);
  if (typeof o.provider !== 'string' || typeof o.windowKey !== 'string' || !o.provider || !o.windowKey) return null;
  const scope = pick(o.scope, SCOPES, 'active');
  if (scope === 'account' && typeof o.credentialId !== 'string') return null;
  const id = typeof o.id === 'string' && o.id ? o.id : `${o.provider}-${o.windowKey}-${scope}`;
  return { id, provider: o.provider, windowKey: o.windowKey, scope, ...(scope === 'account' ? { credentialId: o.credentialId as string } : {}) };
}

/** Rebuilds settings from stored JSON, dropping invalid values for their defaults. */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS;
  const r = obj(raw);
  const g = obj(r.general), p = obj(r.proxy), db = obj(r.dashboard), t = obj(r.trayIcons), n = obj(r.notifications);
  const warn = int(t.warnAtPercentUsed, d.trayIcons.warnAtPercentUsed, 1, 99);
  return {
    general: {
      launchAtLogin: bool(g.launchAtLogin, d.general.launchAtLogin),
      startMinimized: bool(g.startMinimized, d.general.startMinimized),
      closeToTray: bool(g.closeToTray, d.general.closeToTray),
      minimizeToTray: bool(g.minimizeToTray, d.general.minimizeToTray),
      theme: pick(g.theme, THEME_CHOICES, d.general.theme),
      confirmQuit: bool(g.confirmQuit, d.general.confirmQuit),
    },
    proxy: {
      autoStart: bool(p.autoStart, d.proxy.autoStart),
      port: int(p.port, d.proxy.port, MIN_USER_PORT, MAX_PORT),
      allowLan: bool(p.allowLan, d.proxy.allowLan),
      strategy: pick(p.strategy, STRATEGIES, d.proxy.strategy),
      sessionAffinity: bool(p.sessionAffinity, d.proxy.sessionAffinity),
      sessionAffinityTtlMinutes: int(p.sessionAffinityTtlMinutes, d.proxy.sessionAffinityTtlMinutes, 1, MAX_AFFINITY_MINUTES),
      executablePath: str(p.executablePath, d.proxy.executablePath),
      restartOnCrash: bool(p.restartOnCrash, d.proxy.restartOnCrash),
      firstByteTimeoutSeconds: int(p.firstByteTimeoutSeconds, d.proxy.firstByteTimeoutSeconds, 0, MAX_FIRST_BYTE_TIMEOUT_SECONDS),
      preferredAccounts: stringRecord(p.preferredAccounts),
    },
    dashboard: {
      refreshIntervalSeconds: int(db.refreshIntervalSeconds, d.dashboard.refreshIntervalSeconds, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS),
      showEmails: bool(db.showEmails, d.dashboard.showEmails),
      forecastDays: int(db.forecastDays, d.dashboard.forecastDays, 1, MAX_FORECAST_DAYS),
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
    },
    notifications: {
      limitHit: bool(n.limitHit, d.notifications.limitHit),
      limitReset: bool(n.limitReset, d.notifications.limitReset),
      accountSwitched: bool(n.accountSwitched, d.notifications.accountSwitched),
      proxyCrashed: bool(n.proxyCrashed, d.notifications.proxyCrashed),
    },
  };
}

/** Settings written to config.yaml that a running proxy reloads live. */
export function proxyConfigChanged(a: AppSettings, b: AppSettings): boolean {
  return a.proxy.strategy !== b.proxy.strategy || a.proxy.sessionAffinity !== b.proxy.sessionAffinity ||
    a.proxy.sessionAffinityTtlMinutes !== b.proxy.sessionAffinityTtlMinutes || a.proxy.firstByteTimeoutSeconds !== b.proxy.firstByteTimeoutSeconds;
}

/** Settings whose change requires the proxy to be restarted to take effect. */
export function proxyRestartNeeded(a: AppSettings, b: AppSettings): boolean {
  return a.proxy.port !== b.proxy.port || a.proxy.allowLan !== b.proxy.allowLan || a.proxy.executablePath !== b.proxy.executablePath;
}
