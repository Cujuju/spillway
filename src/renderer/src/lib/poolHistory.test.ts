import { describe, expect, it } from 'vitest';
import type { Credential, HistorySample } from '@shared/types';
import { couplingRatios, drainRatePerHour, drainSeries, pastSeries } from './poolHistory';

const H = 3_600_000;
const WEEK = 168 * H;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const sample = (at: number, used: HistorySample['used'], resets?: HistorySample['resets']): HistorySample => ({ at: iso(at), used, resets });
const weekly = (id: string, used: number): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false, weight: 1,
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
    expect(drainRatePerHour(samples, ['a'], 'seven_day', NOW, 24)).toBe(3);
  });
  it('treats a drop without a recorded reset as no use', () => {
    const samples = [
      sample(NOW - 2 * H, { a: { seven_day: 50.4 } }, { a: { seven_day: NOW + H } }),
      sample(NOW - H, { a: { seven_day: 50 } }, { a: { seven_day: NOW + H } }),
      sample(NOW, { a: { seven_day: 52 } }),
    ];
    expect(drainRatePerHour(samples, ['a'], 'seven_day', NOW, 24)).toBe(1);
  });
  it('needs two samples', () => {
    expect(drainRatePerHour([], ['a'], 'seven_day', NOW, 24)).toBeNull();
  });
});

describe('couplingRatios', () => {
  it('pools how far each other window moved per 1% of the projected one, across resets', () => {
    const samples = [
      sample(NOW - 2 * H, { a: { seven_day: 10, five_hour: 90 }, b: { seven_day: 0, five_hour: 0 } }, { a: { five_hour: NOW - H } }),
      sample(NOW - H, { a: { seven_day: 12, five_hour: 6 }, b: { seven_day: 1, five_hour: 4 } }),
    ];
    // seven_day moved 3; five_hour 6 after a's reset plus 4 on b.
    expect(couplingRatios(samples, ['a', 'b'], 'seven_day', NOW, 24)).toEqual({ five_hour: 10 / 3 });
  });
  it('is empty when the projected window did not move', () => {
    const samples = [sample(NOW - H, { a: { seven_day: 5, five_hour: 1 } }), sample(NOW, { a: { seven_day: 5, five_hour: 9 } })];
    expect(couplingRatios(samples, ['a'], 'seven_day', NOW, 24)).toEqual({});
  });
});

describe('pastSeries', () => {
  it('carries values forward and seeds accounts without history from their current value', () => {
    const samples = [sample(NOW - 2 * H, { a: { seven_day: 10 } }), sample(NOW - H, { a: { seven_day: 20 } })];
    expect(pastSeries(samples, [weekly('a', 20), weekly('new', 30)], 'seven_day', 0).map((p) => p.remaining)).toEqual([160, 150]);
  });
});

describe('drainSeries', () => {
  it('rates use per hour, counting from zero after a recorded reset', () => {
    const s = [
      sample(NOW, { a: { k: 10 } }, { a: { k: NOW + 2.5 * H } }),
      sample(NOW + 2 * H, { a: { k: 30 } }, { a: { k: NOW + 2.5 * H } }),
      sample(NOW + 3 * H, { a: { k: 4 } }),
    ];
    expect(drainSeries(s, ['a'], 'k', 0).map((p) => p.remaining)).toEqual([10, 4]);
  });
});
