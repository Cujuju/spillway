import { describe, expect, it } from 'vitest';
import type { Credential, CredentialPlan, HistorySample } from '@shared/types';
import { poolShares } from './poolCapacity';

const H = 3_600_000;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const MAX_5X: CredentialPlan = { tier: 'default_claude_max_5x', label: 'Max 5x', multiplier: 5 };
const PRO: CredentialPlan = { tier: 'default_claude_ai', label: 'Pro', multiplier: 1 };
const account = (id: string, plan: CredentialPlan | null): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  weight: 1, plan,
  windows: [
    { key: 'five_hour', label: '5-hour', usedPercent: 0, resetsAt: null, status: 'allowed', durationMs: 5 * H, scoped: false, resetCadence: 'on_use' },
    { key: 'seven_day', label: 'Weekly', usedPercent: 0, resetsAt: null, status: 'allowed', durationMs: 168 * H, scoped: false, resetCadence: 'fixed' },
  ],
});
const at = (t: number, used: HistorySample['used']): HistorySample => ({ at: new Date(t).toISOString(), used });

describe('poolShares', () => {
  it('sizes the 5-hour pool by plan multiple', () => {
    const shares = poolShares([], [account('max', MAX_5X), account('pro', PRO)], 'five_hour');
    expect(shares.get('max')!.share).toBeCloseTo(5 / 6);
    expect(shares.get('pro')!.share).toBeCloseTo(1 / 6);
    // 1% of the pool is 6/5% of the Max session window and 6% of the Pro one.
    expect(shares.get('pro')!.cost.five_hour).toBeCloseTo(6);
  });
  it('sizes weekly windows from each account\'s own 5-hour-to-weekly ratio', () => {
    // Pro: 50% of a session moved weekly 5% (10:1). Max 5x: 50% moved weekly 7.1% (7:1).
    const samples = [
      at(NOW - 2 * H, { max: { five_hour: 0, seven_day: 0 }, pro: { five_hour: 0, seven_day: 0 } }),
      at(NOW - H, { max: { five_hour: 50, seven_day: 50 / 7 }, pro: { five_hour: 50, seven_day: 5 } }),
    ];
    const shares = poolShares(samples, [account('max', MAX_5X), account('pro', PRO)], 'seven_day');
    // Weekly sizes in Pro sessions: Max 5 x 7 = 35, Pro 1 x 10 = 10.
    expect(shares.get('max')!.share).toBeCloseTo(35 / 45);
    // On the weekly view a pool percent costs the session window ratio-times more.
    const pro = shares.get('pro')!;
    expect(pro.cost.five_hour! / pro.cost.seven_day!).toBeCloseTo(10);
  });
  it('borrows a measured ratio for an account without enough history', () => {
    const samples = [
      at(NOW - 2 * H, { pro: { five_hour: 0, seven_day: 0 } }),
      at(NOW - H, { pro: { five_hour: 50, seven_day: 5 } }),
    ];
    const shares = poolShares(samples, [account('max', MAX_5X), account('pro', PRO)], 'seven_day');
    expect(shares.get('max')!.share).toBeCloseTo(50 / 60);
  });
  it('without any measured ratio, weights by plan and leaves the windows uncoupled', () => {
    const shares = poolShares([], [account('max', MAX_5X), account('pro', PRO)], 'seven_day');
    expect(shares.get('max')!.share).toBeCloseTo(5 / 6);
    expect(shares.get('max')!.cost.five_hour).toBeUndefined();
  });
  it('treats an unknown plan as Pro-sized', () => {
    const shares = poolShares([], [account('a', null), account('b', null)], 'five_hour');
    expect(shares.get('a')!.share).toBe(0.5);
  });
});
