import type { Credential, UsageSnapshot } from '@shared/types';

export type UsageEvent =
  | { kind: 'limitHit'; credential: Credential; windowLabel: string; resetsAt: string | null }
  | { kind: 'limitReset'; credential: Credential; windowLabel: string }
  | { kind: 'accountSwitched'; provider: string; from: Credential | null; to: Credential };

const rejectedWindows = (c: Credential) => new Map(c.windows.filter((w) => w.status === 'rejected').map((w) => [w.key, w]));

/** Transitions between two snapshots that are worth a notification. */
export function diffUsage(prev: UsageSnapshot | null, next: UsageSnapshot): UsageEvent[] {
  if (!prev) return [];
  const events: UsageEvent[] = [];
  const before = new Map(prev.credentials.map((c) => [c.id, c]));
  for (const c of next.credentials) {
    const old = before.get(c.id);
    if (!old) continue;
    const wasRejected = rejectedWindows(old);
    const isRejected = rejectedWindows(c);
    for (const [key, w] of isRejected) {
      if (!wasRejected.has(key)) events.push({ kind: 'limitHit', credential: c, windowLabel: w.label, resetsAt: w.resetsAt });
    }
    for (const [key, w] of wasRejected) {
      if (!isRejected.has(key)) events.push({ kind: 'limitReset', credential: c, windowLabel: w.label });
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
