import { describe, expect, it } from 'vitest';
import type { Credential, HistorySample } from '@shared/types';
import { depletionAt, drainRatePerHour, drainSeries, pastSeries, poolSummary, poolWindowKey, project, windowPeriodMs } from './forecast';

const H = 3_600_000;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const cred = (id: string, used: number, resetIn: number | null, disabled = false): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false,
  windows: [
    { key: 'five_hour', label: '5-hour', usedPercent: 10, resetsAt: null, status: 'allowed' },
    { key: 'seven_day', label: 'Weekly', usedPercent: used, resetsAt: resetIn === null ? null : iso(NOW + resetIn), status: 'allowed' },
  ],
});

describe('windows', () => {
  it('maps known keys to periods', () => {
    expect(windowPeriodMs('five_hour')).toBe(5 * H);
    expect(windowPeriodMs('seven_day_opus')).toBe(168 * H);
    expect(windowPeriodMs('mystery')).toBeNull();
  });
  it('picks the longest reported window', () => {
    expect(poolWindowKey([cred('a', 10, H)])).toBe('seven_day');
  });
});

describe('poolSummary', () => {
  it('sums remaining over enabled accounts', () => {
    expect(poolSummary([cred('a', 40, H), cred('b', 10, H), cred('c', 0, H, true)], 'seven_day'))
      .toEqual({ remaining: 150, capacity: 200, accounts: 2 });
  });
});

describe('drainRatePerHour', () => {
  it('sums increases and ignores resets', () => {
    const samples = [
      { at: iso(NOW - 4 * H), used: { a: { seven_day: 10 } } },
      { at: iso(NOW - 2 * H), used: { a: { seven_day: 18 } } },
      { at: iso(NOW - H), used: { a: { seven_day: 0 } } },
      { at: iso(NOW), used: { a: { seven_day: 4 } } },
    ];
    expect(drainRatePerHour(samples, ['a'], 'seven_day', NOW, 24)).toBe(3);
  });
  it('needs two samples', () => {
    expect(drainRatePerHour([], ['a'], 'seven_day', NOW, 24)).toBeNull();
  });
});

describe('pastSeries', () => {
  it('carries values forward per account', () => {
    const samples: HistorySample[] = [
      { at: iso(NOW - 2 * H), used: { a: { seven_day: 10 }, b: { seven_day: 50 } } },
      { at: iso(NOW - H), used: { a: { seven_day: 20 } } },
    ];
    expect(pastSeries(samples, ['a', 'b'], 'seven_day', 0).map((p) => p.remaining)).toEqual([140, 130]);
  });
});

describe('project', () => {
  it('drains the soonest-resetting account first and refills it at reset', () => {
    const creds = [cred('soon', 50, 2 * H), cred('late', 0, 100 * H)];
    const p = project(creds, 'seven_day', 10, NOW, 1);
    expect(p.points[0]!.remaining).toBe(150);
    // After 1h: 10% drained from "soon".
    expect(p.points[4]!.remaining).toBeCloseTo(140);
    // At 2h "soon" resets, restoring its use after 7 drained 15-min steps: 50 + 7 * 2.5.
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 67.5 });
  });
  it('stays flat without drain', () => {
    const p = project([cred('a', 30, null)], 'seven_day', 0, NOW, 1);
    expect(new Set(p.points.map((x) => x.remaining))).toEqual(new Set([70]));
  });
});

describe('drainSeries / depletionAt', () => {
  it('rates increases per hour and ignores resets', () => {
    const s: HistorySample[] = [
      { at: '2026-01-01T00:00:00Z', used: { a: { k: 10 } } },
      { at: '2026-01-01T02:00:00Z', used: { a: { k: 30 } } },
      { at: '2026-01-01T03:00:00Z', used: { a: { k: 0 } } },
    ];
    const out = drainSeries(s, ['a'], 'k', 0);
    expect(out.map((p) => p.remaining)).toEqual([10, 0]);
  });
  it('finds the first empty point', () => {
    expect(depletionAt([{ t: 1, remaining: 5 }, { t: 2, remaining: 0 }])).toBe(2);
    expect(depletionAt([{ t: 1, remaining: 5 }])).toBeNull();
  });
});
