import { describe, expect, it } from 'vitest';
import type { Credential, HistorySample, LimitWindow } from '@shared/types';
import { depletionAt, drainRatePerHour, drainSeries, pastSeries, poolSummary, poolWindowKey, project } from './forecast';

const H = 3_600_000;
const FIVE_H = 5 * H;
const WEEK = 168 * H;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const win = (key: string, used: number | null, resetIn: number | null, durationMs: number | null, scoped = false): LimitWindow => ({
  key, label: key, usedPercent: used, resetsAt: resetIn === null ? null : iso(NOW + resetIn), status: 'allowed', durationMs, scoped,
});
const account = (id: string, windows: LimitWindow[], patch: Partial<Credential> = {}): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  windows, ...patch,
});
/** Weekly-only account: `used` percent, resetting `resetIn` from NOW. */
const weekly = (id: string, used: number, resetIn: number | null, patch: Partial<Credential> = {}) =>
  account(id, [win('five_hour', 10, null, FIVE_H), win('seven_day', used, resetIn, WEEK)], patch);
const sample = (at: number, used: HistorySample['used'], resets?: HistorySample['resets']): HistorySample => ({ at: iso(at), used, resets });

describe('poolWindowKey', () => {
  it('picks the longest account-wide window', () => {
    expect(poolWindowKey([weekly('a', 10, H)])).toBe('seven_day');
  });
  it('prefers account-wide over a scoped window of the same length', () => {
    const c = account('a', [win('seven_day_fable', 5, H, WEEK, true), win('seven_day', 5, H, WEEK)]);
    expect(poolWindowKey([c])).toBe('seven_day');
  });
});

describe('poolSummary', () => {
  it('sums remaining over enabled accounts', () => {
    expect(poolSummary([weekly('a', 40, H), weekly('b', 10, H), weekly('c', 0, H, { disabled: true })], 'seven_day'))
      .toEqual({ remaining: 150, capacity: 200, accounts: 2 });
  });
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

describe('pastSeries', () => {
  it('carries values forward and seeds accounts without history from their current value', () => {
    const samples = [sample(NOW - 2 * H, { a: { seven_day: 10 } }), sample(NOW - H, { a: { seven_day: 20 } })];
    const creds = [weekly('a', 20, H), weekly('new', 30, H)];
    expect(pastSeries(samples, creds, 'seven_day', 0).map((p) => p.remaining)).toEqual([160, 150]);
  });
});

describe('project', () => {
  it('soonest-reset drains the account whose weekly window resets first, even on the 5-hour view', () => {
    const early = account('early', [win('five_hour', 0, 4 * H, FIVE_H), win('seven_day', 0, 24 * H, WEEK)]);
    const late = account('late', [win('five_hour', 0, H, FIVE_H), win('seven_day', 0, 96 * H, WEEK)]);
    const p = project([late, early], 'five_hour', 20, NOW, 1, 'soonest-reset');
    // At 1h "late" resets with nothing used: all drain went to "early", 15 steps of 5% by its 4h reset.
    expect(p.points[4]!.remaining).toBeCloseTo(180);
    expect(p.nextReset).toEqual({ at: NOW + 4 * H, restores: 75 });
  });
  it('reports the reset at its own time, not the step after it', () => {
    const p = project([weekly('soon', 50, 2 * H + 7 * 60_000), weekly('late', 0, 100 * H)], 'seven_day', 0, NOW, 1, 'soonest-reset');
    expect(p.nextReset).toEqual({ at: NOW + 2 * H + 7 * 60_000, restores: 50 });
  });
  it('round-robin splits drain evenly and passes a full account\'s share on', () => {
    const p = project([weekly('a', 95, null), weekly('b', 0, null), weekly('c', 0, null)], 'seven_day', 12, NOW, 1, 'round-robin');
    // One hour: 12% split three ways, "a" only has 5% room; the rest is shared by b and c.
    expect(p.points[4]!.remaining).toBeCloseTo(205 - 12);
  });
  it('fill-first drains the highest priority first', () => {
    const p = project([weekly('a', 0, 50 * H), weekly('b', 0, 2 * H, { priority: 1 })], 'seven_day', 40, NOW, 1, 'fill-first');
    // "b" takes every step before its 2h reset: 7 steps of 10%.
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 70 });
  });
  it('the preferred account takes drain ahead of the strategy', () => {
    const p = project([weekly('a', 0, 2 * H), weekly('b', 0, 50 * H, { preferred: true })], 'seven_day', 10, NOW, 1, 'soonest-reset');
    expect(p.nextReset).toBeNull();
  });
  it('a benched account takes no drain until its cooldown ends', () => {
    const p = project([weekly('a', 0, 2 * H, { cooldownUntil: iso(NOW + 3 * H) }), weekly('b', 0, 50 * H)], 'seven_day', 10, NOW, 1, 'soonest-reset');
    expect(p.nextReset).toBeNull();
  });
  it('an unused window starts on its first use and resets a window length later', () => {
    const p = project([account('a', [win('five_hour', 0, null, FIVE_H)])], 'five_hour', 10, NOW, 1, 'soonest-reset');
    expect(p.nextReset?.at).toBe(NOW + 0.25 * H + FIVE_H);
  });
  it('drains to exactly zero', () => {
    const p = project([weekly('a', 90, null)], 'seven_day', 10, NOW, 1, 'soonest-reset');
    expect(depletionAt(p.points)).toBe(NOW + H);
  });
  it('stays flat without drain', () => {
    const p = project([weekly('a', 30, null)], 'seven_day', 0, NOW, 1, 'soonest-reset');
    expect(new Set(p.points.map((x) => x.remaining))).toEqual(new Set([70]));
  });
});

describe('drainSeries / depletionAt', () => {
  it('rates use per hour, counting from zero after a recorded reset', () => {
    const s = [
      sample(NOW, { a: { k: 10 } }, { a: { k: NOW + 2.5 * H } }),
      sample(NOW + 2 * H, { a: { k: 30 } }, { a: { k: NOW + 2.5 * H } }),
      sample(NOW + 3 * H, { a: { k: 4 } }),
    ];
    expect(drainSeries(s, ['a'], 'k', 0).map((p) => p.remaining)).toEqual([10, 4]);
  });
  it('finds the first empty point', () => {
    expect(depletionAt([{ t: 1, remaining: 5 }, { t: 2, remaining: 0 }])).toBe(2);
    expect(depletionAt([{ t: 1, remaining: 5 }])).toBeNull();
  });
});
