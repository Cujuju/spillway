import { describe, expect, it } from 'vitest';
import { accountState } from './accountState';
import type { Credential } from './types';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const MINUTE_MS = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const cred = (patch: Partial<Credential> = {}): Credential => ({
  id: 'a', name: 'a', authIndex: 'a', provider: 'claude', label: 'a', note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, accountView: false, preferred: false,
  weight: 1, plan: null, resetCredits: null, windows: [], ...patch,
});

describe('accountState', () => {
  it('ranks disabled, limited, next pick, error, then ready', () => {
    expect(accountState(cred({ disabled: true, nextPick: true }), NOW)).toBe('disabled');
    expect(accountState(cred({ cooldownUntil: iso(NOW + MINUTE_MS), nextPick: true }), NOW)).toBe('limited');
    expect(accountState(cred({ nextPick: true, status: 'error' }), NOW)).toBe('next-pick');
    expect(accountState(cred({ status: 'error' }), NOW)).toBe('error');
    expect(accountState(cred(), NOW)).toBe('ready');
  });
  it('stops reading limited once the cooldown passes `now`', () => {
    const c = cred({ cooldownUntil: iso(NOW + MINUTE_MS), nextPick: true });
    expect(accountState(c, NOW + MINUTE_MS)).toBe('next-pick');
  });
});
