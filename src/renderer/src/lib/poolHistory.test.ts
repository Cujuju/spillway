import { describe, expect, it } from 'vitest';
import type { Credential, HistorySample } from '@shared/types';
import type { AccountShare } from './poolCapacity';
import { drainRatePerHour, drainSeries, pastSeries } from './poolHistory';

const H = 3_600_000;
const WEEK = 168 * H;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const sample = (at: number, used: HistorySample['used'], resets?: HistorySample['resets']): HistorySample => ({ at: iso(at), used, resets });
/** Equal shares: pool percent is the mean of the accounts' percents. */
const equal = (...ids: string[]) => new Map<string, AccountShare>(ids.map((id) => [id, { share: 1 / ids.length, cost: {} }]));
const weekly = (id: string, used: number): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, accountView: false, preferred: false, weight: 1, plan: null, resetCredits: null,
  windows: [{ key: 'seven_day', label: 'Weekly', usedPercent: used, resetsAt: null, status: 'allowed', durationMs: WEEK, scoped: false, resetCadence: 'fixed' }],
});

describe('drainRatePerHour', () => {
  it('counts use after a recorded reset from zero', () => {
    const resetAt = NOW - 1.5 * H;
    const samples = [
      sample(NOW - 4 * H, { a: { seven_day: 10 } }, { a: { seven_day: resetAt } }),
      sample(NOW - 2 * H, { a: { seven_day: 18 } }, { a: { seven_day: resetAt } }),
      sample(NOW - H, { a: { seven_day: 2 } }, { a: { seven_day: NOW + WEEK } }),
      sample(NOW, { a: { seven_day: 4 } }, { a: { seven_day: NOW + WEEK } }),
    ];
    // 8 before the reset, 2 into the new window, then 2 more over 4 hours.
    expect(drainRatePerHour(samples, equal('a'), 'seven_day', NOW, 24)).toBe(3);
  });
  it('treats a drop without a recorded reset as no use', () => {
    const samples = [
      sample(NOW - 2 * H, { a: { seven_day: 50.4 } }, { a: { seven_day: NOW + H } }),
      sample(NOW - H, { a: { seven_day: 50 } }, { a: { seven_day: NOW + H } }),
      sample(NOW, { a: { seven_day: 52 } }),
    ];
    expect(drainRatePerHour(samples, equal('a'), 'seven_day', NOW, 24)).toBe(1);
  });
  it('needs two samples', () => {
    expect(drainRatePerHour([], equal('a'), 'seven_day', NOW, 24)).toBeNull();
  });
  it('weights each account by its share of the pool', () => {
    const samples = [sample(NOW - H, { max: { k: 0 }, pro: { k: 0 } }), sample(NOW, { max: { k: 10 }, pro: { k: 30 } })];
    const shares = new Map<string, AccountShare>([['max', { share: 0.8, cost: {} }], ['pro', { share: 0.2, cost: {} }]]);
    expect(drainRatePerHour(samples, shares, 'k', NOW, 24)).toBeCloseTo(14);
  });
});

describe('pastSeries', () => {
  it('carries values forward and seeds accounts without history from their current value', () => {
    const samples = [sample(NOW - 2 * H, { a: { seven_day: 10 } }), sample(NOW - H, { a: { seven_day: 20 } })];
    expect(pastSeries(samples, [weekly('a', 20), weekly('new', 30)], 'seven_day', 0, equal('a', 'new')).map((p) => p.remaining)).toEqual([80, 75]);
  });
});

describe('drainSeries', () => {
  it('rates use per hour, counting from zero after a recorded reset', () => {
    const s = [
      sample(NOW, { a: { k: 10 } }, { a: { k: NOW + 2.5 * H } }),
      sample(NOW + 2 * H, { a: { k: 30 } }, { a: { k: NOW + 2.5 * H } }),
      sample(NOW + 3 * H, { a: { k: 4 } }),
    ];
    expect(drainSeries(s, equal('a'), 'k', 0).map((p) => p.remaining)).toEqual([10, 4]);
  });
});
