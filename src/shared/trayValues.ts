import type { TrayIconSpec, TrayIconValue } from './settings';
import type { Credential, UsageSnapshot } from './types';

export interface TrayReading {
  /** Used percent 0–100, or null when no account has data for this window. */
  usedPercent: number | null;
  /** Earliest reset among the accounts that produced the reading. */
  resetsAt: string | null;
  /** Short line for the tooltip, e.g. "Claude 5-hour · work@…". */
  title: string;
  source: string;
}

/** Labels the proxy gives Claude windows (quota_windows.go), used before any usage data arrives. */
export const KNOWN_WINDOW_LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' };
export const windowLabel = (key: string) => KNOWN_WINDOW_LABELS[key] ?? key;

/** Percent of one provider's pool left in `windowKey`, accounts weighted by plan size (renderer `poolRemaining`). */
export type PoolRemaining = (credentials: Credential[], windowKey: string) => number;

const FULL = 100;
const usable = (c: Credential) => !c.disabled;
const windowOf = (c: Credential, key: string) => c.windows.find((w) => w.key === key);
const earliest = (dates: (string | null)[]) =>
  dates.filter((d): d is string => !!d).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;

export function providerLabel(provider: string): string {
  const known: Record<string, string> = {
    claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', kimi: 'Kimi', xai: 'xAI', devin: 'Devin', meta: 'Muse', gemini: 'Gemini',
  };
  return known[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Computes what one tray icon shows from the latest snapshot. */
export function readTray(
  spec: Pick<TrayIconSpec, 'provider' | 'windowKey' | 'scope' | 'credentialId'>,
  snapshot: UsageSnapshot | null,
  poolRemaining: PoolRemaining,
): TrayReading {
  const accounts = (snapshot?.credentials ?? []).filter((c) => c.provider === spec.provider && usable(c));
  const withWindow = accounts.filter((c) => windowOf(c, spec.windowKey)?.usedPercent != null);
  const label = withWindow.length ? windowOf(withWindow[0]!, spec.windowKey)!.label : windowLabel(spec.windowKey);
  const title = `${providerLabel(spec.provider)} ${label}`;
  const empty: TrayReading = { usedPercent: null, resetsAt: null, title, source: 'no data' };
  if (!withWindow.length) return empty;

  if (spec.scope === 'account') {
    const c = withWindow.find((a) => a.id === spec.credentialId);
    const w = c && windowOf(c, spec.windowKey);
    return c && w ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt, title, source: c.label } : empty;
  }
  if (spec.scope === 'active') {
    const c = withWindow.find((a) => a.nextPick) ?? withWindow[0]!;
    const w = windowOf(c, spec.windowKey)!;
    return { usedPercent: w.usedPercent, resetsAt: w.resetsAt, title, source: c.label };
  }
  if (spec.scope === 'lowest') {
    const c = [...withWindow].sort((a, b) => windowOf(b, spec.windowKey)!.usedPercent! - windowOf(a, spec.windowKey)!.usedPercent!)[0]!;
    const w = windowOf(c, spec.windowKey)!;
    return { usedPercent: w.usedPercent, resetsAt: w.resetsAt, title, source: `${c.label} (least left)` };
  }
  // Pool: the Dashboard's figure, so 100 used means every account is exhausted.
  return {
    usedPercent: FULL - poolRemaining(withWindow, spec.windowKey),
    resetsAt: earliest(withWindow.map((c) => windowOf(c, spec.windowKey)!.resetsAt)),
    title,
    source: `${withWindow.length} accounts pooled`,
  };
}

/** Percent the icon shows for its 'remaining' or 'used' setting; null when there is no data. */
export function shownPercent(usedPercent: number | null, value: TrayIconValue): number | null {
  if (usedPercent === null) return null;
  return Math.max(0, value === 'remaining' ? 100 - usedPercent : usedPercent);
}

/**
 * Converts a threshold between percent used (how it is stored) and the icon's unit, so Warn at and
 * Critical at read the same way as the digits. Its own inverse: apply it again to store.
 */
export const thresholdInUnit = (percent: number, value: TrayIconValue) => (value === 'remaining' ? 100 - percent : percent);

/** Digits drawn on the icon; a dash when there is no data. */
export const trayIconText = (shown: number | null) => (shown === null ? '–' : String(Math.round(shown)));

export type TrayLevel = 'ok' | 'warn' | 'critical' | 'none';

export function trayLevel(usedPercent: number | null, warnAt: number, criticalAt: number): TrayLevel {
  if (usedPercent === null) return 'none';
  if (usedPercent >= criticalAt) return 'critical';
  if (usedPercent >= warnAt) return 'warn';
  return 'ok';
}
