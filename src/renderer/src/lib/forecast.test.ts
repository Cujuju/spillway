import { describe, expect, it } from 'vitest';
import type { Credential, LimitWindow } from '@shared/types';
import { depletionAt, poolSummary, poolWindowKey, project, type Drain } from './forecast';

const H = 3_600_000;
const STEP = 0.25 * H;
const FIVE_H = 5 * H;
const WEEK = 168 * H;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const win = (
  key: string, used: number | null, resetIn: number | null, durationMs: number | null,
  patch: Partial<LimitWindow> = {},
): LimitWindow => ({
  key, label: key, usedPercent: used, resetsAt: resetIn === null ? null : iso(NOW + resetIn), status: 'allowed', durationMs,
  scoped: false, resetCadence: null, ...patch,
});
const account = (id: string, windows: LimitWindow[], patch: Partial<Credential> = {}): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  weight: 1, windows, ...patch,
});
/** Weekly account with an idle 5-hour window: `used` percent, resetting `resetIn` from NOW. */
const weekly = (id: string, used: number, resetIn: number | null, patch: Partial<Credential> = {}) =>
  account(id, [win('five_hour', 10, null, FIVE_H), win('seven_day', used, resetIn, WEEK)], patch);
const drain = (perHour: number, ratios: Drain['ratios'] = {}): Drain => ({ perHour, ratios });
const at = (p: { points: { t: number; remaining: number }[] }, t: number) => p.points.find((x) => x.t === t)!.remaining;

describe('poolWindowKey', () => {
  it('picks the longest account-wide window', () => {
    expect(poolWindowKey([weekly('a', 10, H)])).toBe('seven_day');
  });
  it('prefers account-wide over a scoped window of the same length', () => {
    const c = account('a', [win('seven_day_fable', 5, H, WEEK, { scoped: true }), win('seven_day', 5, H, WEEK)]);
    expect(poolWindowKey([c])).toBe('seven_day');
  });
});

describe('poolSummary', () => {
  it('sums remaining over enabled accounts', () => {
    expect(poolSummary([weekly('a', 40, H), weekly('b', 10, H), weekly('c', 0, H, { disabled: true })], 'seven_day'))
      .toEqual({ remaining: 150, capacity: 200, accounts: 2 });
  });
});

describe('project: routing', () => {
  it('soonest-reset drains the account whose weekly window resets first, even on the 5-hour view', () => {
    const early = account('early', [win('five_hour', 0, 4 * H, FIVE_H), win('seven_day', 0, 24 * H, WEEK)]);
    const late = account('late', [win('five_hour', 0, H, FIVE_H), win('seven_day', 0, 96 * H, WEEK)]);
    const p = project([late, early], 'five_hour', drain(20), NOW, 1, 'soonest-reset');
    // At 1h "late" resets with nothing used: all drain went to "early", 15 steps of 5% by its 4h reset.
    expect(p.points[4]!.remaining).toBeCloseTo(180);
    expect(p.nextReset).toEqual({ at: NOW + 4 * H, restores: 75 });
  });
  it('reports the reset at its own time, not the step after it', () => {
    const p = project([weekly('soon', 50, 2 * H + 7 * 60_000), weekly('late', 0, 100 * H)], 'seven_day', drain(0), NOW, 1, 'soonest-reset');
    expect(p.nextReset).toEqual({ at: NOW + 2 * H + 7 * 60_000, restores: 50 });
  });
  it('every strategy uses the highest priority tier first', () => {
    const accounts = [weekly('a', 0, 2 * H), weekly('b', 0, 50 * H, { priority: 1 })];
    // "a" resets first but sits in the lower tier, so it stays unused.
    expect(project(accounts, 'seven_day', drain(10), NOW, 1, 'soonest-reset').nextReset).toBeNull();
    expect(project(accounts, 'seven_day', drain(10), NOW, 1, 'round-robin').nextReset).toBeNull();
  });
  it('fill-first drains the first account by ID in the top tier', () => {
    const p = project([weekly('b', 0, 50 * H), weekly('a', 0, 2 * H)], 'seven_day', drain(40), NOW, 1, 'fill-first');
    // "a" takes every step before its 2h reset: 7 steps of 10%.
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 70 });
  });
  it('round-robin splits drain evenly and passes a full account\'s share on', () => {
    const p = project([weekly('a', 95, null), weekly('b', 0, null), weekly('c', 0, null)], 'seven_day', drain(12), NOW, 1, 'round-robin');
    // One hour: 12% split three ways, "a" only has 5% room; the rest is shared by b and c.
    expect(p.points[4]!.remaining).toBeCloseTo(205 - 12);
  });
  it('weighted round robin splits by weight and skips weight 0; plain round robin ignores weights', () => {
    const accounts = [weekly('a', 0, 2 * H, { weight: 3 }), weekly('b', 0, 100 * H), weekly('c', 0, H, { weight: 0 })];
    // 2% a step: "a" gets 3/4 for the 7 steps before its 2h reset.
    expect(project(accounts, 'seven_day', drain(8), NOW, 1, 'weighted-round-robin').nextReset).toEqual({ at: NOW + 2 * H, restores: 10.5 });
    // Even thirds; "c" resets first, after 3 steps.
    expect(project(accounts, 'seven_day', drain(8), NOW, 1, 'round-robin').nextReset?.restores).toBeCloseTo(2);
  });
  it('the preferred account takes drain ahead of the strategy', () => {
    const p = project([weekly('a', 0, 2 * H), weekly('b', 0, 50 * H, { preferred: true })], 'seven_day', drain(10), NOW, 1, 'soonest-reset');
    expect(p.nextReset).toBeNull();
  });
  it('a benched account takes no drain until its cooldown ends', () => {
    const p = project([weekly('a', 0, 2 * H, { cooldownUntil: iso(NOW + 3 * H) }), weekly('b', 0, 50 * H)], 'seven_day', drain(10), NOW, 1, 'soonest-reset');
    expect(p.nextReset).toBeNull();
  });
});

describe('project: coupled windows', () => {
  it('a full 5-hour window stops an account taking weekly drain', () => {
    const capped = account('capped', [win('five_hour', 95, 4 * H, FIVE_H), win('seven_day', 0, 2 * H, WEEK)]);
    const spare = account('spare', [win('five_hour', 0, null, FIVE_H), win('seven_day', 0, 96 * H, WEEK)]);
    // 1% weekly a step costs 5% of the 5-hour window: "capped" has room for one step.
    const p = project([capped, spare], 'seven_day', drain(4, { five_hour: 5 }), NOW, 1, 'soonest-reset');
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 1 });
    expect(at(p, NOW + H)).toBeCloseTo(196);
  });
  it('a full weekly window stops an account taking 5-hour drain', () => {
    const capped = account('capped', [win('five_hour', 0, null, FIVE_H), win('seven_day', 99, 96 * H, WEEK)]);
    const spare = account('spare', [win('five_hour', 0, null, FIVE_H), win('seven_day', 0, 120 * H, WEEK)]);
    const p = project([capped, spare], 'five_hour', drain(20, { seven_day: 0.2 }), NOW, 1, 'soonest-reset');
    // "capped" takes one 5% step (1% weekly), starting its 5-hour window then.
    expect(p.nextReset).toEqual({ at: NOW + STEP + FIVE_H, restores: 5 });
  });
  it('without a measured ratio the other window does not cap', () => {
    const capped = account('capped', [win('five_hour', 100, 4 * H, FIVE_H), win('seven_day', 0, 2 * H, WEEK)]);
    const p = project([capped], 'seven_day', drain(4), NOW, 1, 'soonest-reset');
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 7 });
  });
});

describe('project: reset cadence', () => {
  // "a" refills at 2h, then idles while higher-tier "b" takes the drain until it fills at 10h.
  const after = (cadence: LimitWindow['resetCadence']) => project([
    account('a', [win('seven_day', 50, 2 * H, WEEK, { resetCadence: cadence })]),
    account('b', [win('seven_day', 90, null, WEEK)], { priority: 1 }),
  ], 'seven_day', drain(1), NOW, 8, 'soonest-reset');
  it('a fixed-cadence window resets one period after its last reset, used or not', () => {
    expect(at(after('fixed'), NOW + 2 * H + WEEK)).toBeCloseTo(100 - 0.25);
  });
  it('an on-use window starts its next period with its first use after the reset', () => {
    const p = after('on_use');
    expect(at(p, NOW + 2 * H + WEEK)).toBe(0);
    expect(at(p, NOW + 10 * H + STEP + WEEK)).toBeCloseTo(100 - 0.25);
  });
  it('an unused window with no reset starts on its first use', () => {
    const p = project([account('a', [win('five_hour', 0, null, FIVE_H)])], 'five_hour', drain(10), NOW, 1, 'soonest-reset');
    expect(p.nextReset?.at).toBe(NOW + STEP + FIVE_H);
  });
});

describe('project: edges / depletionAt', () => {
  it('drains to exactly zero', () => {
    const p = project([weekly('a', 90, null)], 'seven_day', drain(10), NOW, 1, 'soonest-reset');
    expect(depletionAt(p.points)).toBe(NOW + H);
  });
  it('stays flat without drain', () => {
    const p = project([weekly('a', 30, null)], 'seven_day', drain(0), NOW, 1, 'soonest-reset');
    expect(new Set(p.points.map((x) => x.remaining))).toEqual(new Set([70]));
  });
  it('finds the first empty point', () => {
    expect(depletionAt([{ t: 1, remaining: 5 }, { t: 2, remaining: 0 }])).toBe(2);
    expect(depletionAt([{ t: 1, remaining: 5 }])).toBeNull();
  });
});
