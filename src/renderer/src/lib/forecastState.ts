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
  /** Account percent of this window used per 1% of the pool; 0 leaves it out of the cap. */
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

export const remainingOf = (accounts: Account[]) => accounts.reduce((sum, a) => sum + a.share * (FULL - a.windows[0]!.used), 0);

/** Pool percent `w` can still take before it caps. */
export const roomIn = (w: Win) => (w.cost > 0 ? (FULL - w.used) / w.cost : Infinity);
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
