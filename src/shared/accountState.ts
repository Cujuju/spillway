import type { Credential } from './types';

export type AccountState = 'disabled' | 'limited' | 'next-pick' | 'error' | 'ready';

/** One account's routing state at `now` (ms); every view that labels an account reads this. */
export function accountState(c: Credential, now: number): AccountState {
  if (c.disabled) return 'disabled';
  if (c.cooldownUntil && Date.parse(c.cooldownUntil) > now) return 'limited';
  if (c.nextPick) return 'next-pick';
  if (c.status === 'error') return 'error';
  return 'ready';
}
