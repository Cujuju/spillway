import type { Credential, LimitWindow, UsageSnapshot } from '@shared/types';
import { WINDOW_START_PROVIDERS, withinActiveHours, type WindowStartSettings } from '@shared/windowStartSettings';

const PROVIDERS = new Set<string>(WINDOW_START_PROVIDERS);

/** The account-wide window that starts with the first request (the 5-hour window); null when unreported. */
export function sessionWindow(c: Credential): LimitWindow | null {
  return c.windows.find((w) => !w.scoped && w.resetCadence === 'on_use' && w.durationMs) ?? null;
}

/** An enabled subscription login that could take a request now. */
function startable(c: Credential, now: number): boolean {
  if (!PROVIDERS.has(c.provider) || c.apiKey || c.disabled) return false;
  if (c.cooldownUntil && Date.parse(c.cooldownUntil) > now) return false;
  // A reached account-wide limit (e.g. weekly) refuses the request; an unknown reset counts as reached.
  return !c.windows.some((w) => !w.scoped && w.status === 'rejected' && (!w.resetsAt || Date.parse(w.resetsAt) > now));
}

/**
 * When the running window began; null when not running. `ours` is when the app last started it, covering
 * the moments before the proxy reports the new window.
 */
function windowStart(w: LimitWindow, ours: number | undefined, now: number): number | null {
  const length = w.durationMs!;
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  const reported = reset > now ? reset - length : null;
  const started = ours !== undefined && ours + length > now ? ours : null;
  if (reported === null) return started;
  return started === null ? reported : Math.max(reported, started);
}

/**
 * Accounts whose 5-hour window should start now, in snapshot order. Stagger spaces a provider's starts a
 * window length divided by its account count apart, spreading resets evenly.
 */
export function dueForWindowStart(snapshot: UsageSnapshot, settings: WindowStartSettings, now: Date, recentStarts: ReadonlyMap<string, number>): Credential[] {
  if (!settings.enabled || !withinActiveHours(settings.activeHours, now)) return [];
  const t = now.getTime();
  const byProvider = new Map<string, { c: Credential; w: LimitWindow; began: number | null }[]>();
  for (const c of snapshot.credentials) {
    const w = sessionWindow(c);
    if (!w || !startable(c, t)) continue;
    byProvider.set(c.provider, [...(byProvider.get(c.provider) ?? []), { c, w, began: windowStart(w, recentStarts.get(c.id), t) }]);
  }
  const due: Credential[] = [];
  for (const accounts of byProvider.values()) {
    let latest = Math.max(...accounts.map((a) => a.began ?? -Infinity));
    for (const { c, w, began } of accounts) {
      if (began !== null) continue;
      if (settings.stagger && t - latest < w.durationMs! / accounts.length) continue;
      due.push(c);
      latest = t;
    }
  }
  return due;
}
