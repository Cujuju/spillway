import { createEffect, on, type Accessor } from 'solid-js';
import type { Credential, ResetCreditGrant, ResetCreditOutcome } from '@shared/types';

export type GrantScope = ResetCreditGrant['scope'];

/** Display order: the narrow Fable grant first, unknown last. */
const SCOPE_ORDER: readonly GrantScope[] = ['fable', 'general', 'unknown'];

/** Lower-case noun for a scope's reset; Fable is a proper noun. */
export const SCOPE_NOUN: Record<GrantScope, string> = { fable: 'Fable reset', general: 'general reset', unknown: 'unknown reset' };

/**
 * How an account's credits can be spent. `grants`: per-scope Claude grants. `untyped`: Claude
 * credits without grant detail, never spendable. `credits`: Codex, spent by provider default.
 */
export type ResetMode = 'grants' | 'untyped' | 'credits';

export function resetMode(c: Credential): ResetMode {
  if (c.resetCredits?.grants?.length) return 'grants';
  return c.provider === 'claude' ? 'untyped' : 'credits';
}

/** True when the account holds any reset credit or grant worth showing. */
export const hasResetCredits = (c: Credential): boolean =>
  (c.resetCredits?.available ?? 0) > 0 || (c.resetCredits?.grants ?? []).some((g) => g.available > 0);

/** Usable now: known scope, applicable, not blocked, and not past a known expiry. Unknown scope is never redeemable. */
export const isGrantUsable = (g: ResetCreditGrant, at: number): boolean =>
  g.scope !== 'unknown' && g.applicable > 0 && g.unavailableReason === null && (g.expiresAt === null || Date.parse(g.expiresAt) > at);

/** Earliest known expiry first, never-expiring last, then by ID so the choice is deterministic. */
function spendOrder(a: ResetCreditGrant, b: ResetCreditGrant): number {
  const ea = a.expiresAt === null ? Infinity : Date.parse(a.expiresAt);
  const eb = b.expiresAt === null ? Infinity : Date.parse(b.expiresAt);
  return ea !== eb ? ea - eb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface GrantGroup {
  scope: GrantScope;
  available: number;
  applicable: number;
  grants: ResetCreditGrant[];
  /** The grant a hold on this group spends; null when none is usable. Never another scope's. */
  target: ResetCreditGrant | null;
  /** Known expiries still ahead, soonest first. */
  expiries: string[];
}

/** Held grants grouped by scope, each with its own total and spend target. */
export function groupGrants(grants: readonly ResetCreditGrant[], at: number): GrantGroup[] {
  return SCOPE_ORDER.flatMap((scope) => {
    const held = grants.filter((g) => g.scope === scope && g.available > 0).toSorted(spendOrder);
    if (!held.length) return [];
    const usable = held.filter((g) => isGrantUsable(g, at));
    return [{
      scope,
      available: held.reduce((n, g) => n + g.available, 0),
      applicable: usable.reduce((n, g) => n + g.applicable, 0),
      grants: held,
      target: usable[0] ?? null,
      expiries: held.flatMap((g) => (g.expiresAt && Date.parse(g.expiresAt) > at ? [g.expiresAt] : [])).toSorted(),
    }];
  });
}

/** Why a group cannot be spent, for its tooltip. */
export function unusableNote(group: GrantGroup, at: number): string {
  if (group.scope === 'unknown') return 'Unrecognized reset type, so it cannot be used here.';
  const reason = group.grants.find((g) => g.unavailableReason)?.unavailableReason;
  if (reason) return reason;
  if (group.grants.every((g) => g.expiresAt !== null && Date.parse(g.expiresAt) <= at)) return 'Expired.';
  return 'Not currently redeemable.';
}

/** Outcome text; `scope` is the spent grant's scope, absent for Codex's provider-default credit. */
export function outcomeText(outcome: ResetCreditOutcome, account: string, scope?: GrantScope): string {
  const noun = scope ? SCOPE_NOUN[scope] : null;
  switch (outcome) {
    case 'reset':
      return noun ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} applied to ${account}; its limits were re-read.` : `Reset applied to ${account}; its limits were re-read.`;
    case 'nothing_to_reset':
      return `${account} has no limit to clear, so no credit was spent.`;
    case 'no_credit':
      return noun ? `That ${noun} is no longer usable on ${account}; nothing was spent.` : `${account} holds no usable reset credit.`;
    case 'already_redeemed':
      return `That ${noun ?? 'reset'} for ${account} was already redeemed.`;
  }
}

/** Binds a hold to its starting target. A mid-hold target change cancels it; `take` yields the bound ID only while still the target. */
export function createHoldBinding(target: Accessor<string | null>, cancel: () => void) {
  let bound: string | null = null;
  createEffect(on(target, (id) => {
    if (bound !== null && id !== bound) {
      bound = null;
      cancel();
    }
  }, { defer: true }));
  return {
    bind: () => { bound = target(); },
    release: () => { bound = null; },
    take: (): string | null => {
      const id = bound;
      bound = null;
      return id !== null && id === target() ? id : null;
    },
  };
}
