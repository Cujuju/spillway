import type { Credential, LimitWindow, UsageSnapshot } from '@shared/types';

export type UsageEvent =
  | { kind: 'limitHit'; credential: Credential; windowLabel: string; resetsAt: string | null }
  | { kind: 'limitReset'; credential: Credential; windowLabel: string }
  | { kind: 'accountSwitched'; provider: string; from: Credential | null; to: Credential };

const FULL = 100;
const isExhausted = (w: LimitWindow) => w.status === 'rejected' || (w.usedPercent !== null && w.usedPercent >= FULL);

/** Transitions between two snapshots that are worth a notification. */
export function diffUsage(prev: UsageSnapshot | null, next: UsageSnapshot): UsageEvent[] {
  if (!prev) return [];
  const events: UsageEvent[] = [];
  const before = new Map(prev.credentials.map((c) => [c.id, c]));
  for (const c of next.credentials) {
    const old = before.get(c.id);
    if (!old) continue;
    const oldWindows = new Map(old.windows.map((w) => [w.key, w]));
    for (const w of c.windows) {
      const previous = oldWindows.get(w.key);
      if (isExhausted(w)) {
        if (!previous || !isExhausted(previous)) events.push({ kind: 'limitHit', credential: c, windowLabel: w.label, resetsAt: w.resetsAt });
      } else if (previous && isExhausted(previous) && (w.status !== null || w.usedPercent !== null)) {
        // Lookups can omit status; missing data is not evidence of recovery.
        events.push({ kind: 'limitReset', credential: c, windowLabel: w.label });
      }
    }
  }
  const pickOf = (s: UsageSnapshot, provider: string) => s.credentials.find((c) => c.provider === provider && c.nextPick) ?? null;
  const providers = new Set(next.credentials.map((c) => c.provider));
  for (const provider of providers) {
    const from = pickOf(prev, provider);
    const to = pickOf(next, provider);
    if (to && from?.id !== to.id) events.push({ kind: 'accountSwitched', provider, from, to });
  }
  return events;
}
