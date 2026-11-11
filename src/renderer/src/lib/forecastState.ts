import type { Credential, LimitWindow } from '@shared/types';
import type { AccountShare } from './poolCapacity';
import type { StuckBlocker } from './forecast';

const FULL = 100;

export interface Win {
  key: string;
  used: number;
  resetAt: number | null;
  durationMs: number | null;
  resetCadence: LimitWindow['resetCadence'];
  scoped: boolean;
  rejected: boolean;
  /** Account percent used per 1% of the pool; 0 omits consumption modeling but still honors exhaustion. */
  cost: number;
}

export interface Account {
  id: string;
  priority: number;
  weight: number;
  preferred: boolean;
  cooldownUntil: number | null;
  /** Fraction of the pool's capacity this account holds. */
  share: number;
  /** The projected window first, then the account-wide windows that also cap it. */
  windows: Win[];
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);
const toWin = (w: LimitWindow, cost: number): Win => ({
  key: w.key,
  used: Math.min(FULL, Math.max(0, w.usedPercent ?? 0)),
  resetAt: ms(w.resetsAt),
  durationMs: w.durationMs,
  resetCadence: w.resetCadence,
  scoped: w.scoped,
  rejected: w.status === 'rejected',
  cost: w.usedPercent === null ? 0 : cost,
});

export function accountsFor(credentials: Credential[], key: string, shares: Map<string, AccountShare>): Account[] {
  return credentials.flatMap((c) => {
    const s = shares.get(c.id);
    const w = c.windows.find((x) => x.key === key);
    if (!s || !w || w.usedPercent === null) return [];
    const others = c.windows.filter((x) => x.key !== key && !x.scoped).map((x) => toWin(x, s.cost[x.key] ?? 0));
    return [{
      id: c.id,
      priority: c.priority,
      weight: c.weight,
      preferred: c.preferred,
      cooldownUntil: ms(c.cooldownUntil),
      share: s.share,
      windows: [toWin(w, s.cost[key]!), ...others],
    }];
  });
}

/** Longer account-wide windows bound the target; shorter windows can refill within its horizon. */
const capsRemaining = (target: Win, w: Win) => w === target
  || (!w.scoped && w.durationMs !== null && target.durationMs !== null && w.durationMs > target.durationMs);

/** A reached target or longer account-wide window removes this account's remaining contribution. */
export function blockingWindow(a: Account): Win | undefined {
  const target = a.windows[0]!;
  return a.windows.find((w) => capsRemaining(target, w) && (w.used >= FULL || w.rejected));
}

/** Usable target percent, capped by longer windows in the same units. Unknown ratios only cap at exhaustion. */
export function remainingIn(a: Account): number {
  if (blockingWindow(a)) return 0;
  const target = a.windows[0]!;
  let remaining = FULL - target.used;
  if (!(target.cost > 0)) return remaining;
  for (const w of a.windows) {
    if (w === target || !capsRemaining(target, w) || !(w.cost > 0)) continue;
    remaining = Math.min(remaining, (FULL - w.used) * target.cost / w.cost);
  }
  return remaining;
}
export const remainingOf = (accounts: Account[]) => accounts.reduce((sum, a) => sum + a.share * remainingIn(a), 0);

/** Pool percent `w` can still take before it caps. */
export const roomIn = (w: Win) => (w.used >= FULL || w.rejected ? 0 : w.cost > 0 ? (FULL - w.used) / w.cost : Infinity);
export const roomOf = (a: Account) => Math.min(...a.windows.map(roomIn));

/** Snapshot the longest current block per routable account before later simulation events mutate it. */
export function stuckBlockers(accounts: Account[], at: number, weighted: boolean): StuckBlocker[] {
  return accounts.filter((a) => !weighted || a.weight > 0 || a.preferred).map((a) => {
    let window: Win | null = null;
    for (const w of a.windows) {
      if (roomIn(w) <= 0 && (!window || (w.resetAt ?? Infinity) > (window.resetAt ?? Infinity))) window = w;
    }
    const cooldown = a.cooldownUntil !== null && a.cooldownUntil > at;
    if (cooldown && (!window || a.cooldownUntil! > (window.resetAt ?? Infinity))) {
      return { credentialId: a.id, windowKey: null, until: a.cooldownUntil };
    }
    return { credentialId: a.id, windowKey: window!.key, until: window!.resetAt };
  });
}
