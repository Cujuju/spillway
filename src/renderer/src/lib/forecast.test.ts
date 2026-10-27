import { describe, expect, it } from 'vitest';
import type { Credential, CredentialPlan, LimitWindow } from '@shared/types';
import { readTray } from '@shared/trayValues';
import { depletionAt, poolSummary, poolWindowKey, project } from './forecast';
import { poolShares, type AccountShare } from './poolCapacity';

const H = 3_600_000;
const STEP = 0.25 * H;
const FIVE_H = 5 * H;
const WEEK = 168 * H;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const MAX_5X: CredentialPlan = { tier: 'default_claude_max_5x', label: 'Max 5x', multiplier: 5 };
const PRO: CredentialPlan = { tier: 'default_claude_ai', label: 'Pro', multiplier: 1 };
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
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, accountView: false, preferred: false,
  weight: 1, plan: null, resetCredits: null, windows, ...patch,
});
/** Weekly account with an idle 5-hour window: `used` percent, resetting `resetIn` from NOW. */
const weekly = (id: string, used: number, resetIn: number | null, patch: Partial<Credential> = {}) =>
  account(id, [win('five_hour', 10, null, FIVE_H), win('seven_day', used, resetIn, WEEK)], patch);
/** Projects with shares from plans alone (no history): same-plan accounts split the pool evenly. */
const run = (creds: Credential[], key: string, perHour: number, strategy: string, days = 1) =>
  project(creds, key, perHour, NOW, days, strategy, poolShares([], creds, key, []));
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
  it('is the percent of the pool left, over enabled accounts', () => {
    const creds = [weekly('a', 40, H), weekly('b', 10, H), weekly('c', 0, H, { disabled: true })];
    expect(poolSummary(creds, 'seven_day', poolShares([], creds, 'seven_day', []))).toEqual({ remaining: 75, accounts: 2 });
  });
  it('counts a Max 5x account five times a Pro one', () => {
    const creds = [weekly('max', 0, H, { plan: MAX_5X }), weekly('pro', 0, H, { plan: PRO })];
    // 5-hour windows at 10% used: (5 x 90 + 1 x 90) / 6.
    expect(poolSummary(creds, 'five_hour', poolShares([], creds, 'five_hour', [])).remaining).toBeCloseTo(90);
    creds[1]!.windows[0]!.usedPercent = 100;
    expect(poolSummary(creds, 'five_hour', poolShares([], creds, 'five_hour', [])).remaining).toBeCloseTo(75);
  });
  it('is what a pool tray icon shows, weighted by plan', () => {
    const creds = [weekly('max', 0, H, { plan: MAX_5X }), weekly('pro', 0, H, { plan: PRO })];
    creds[1]!.windows[0]!.usedPercent = 100;
    const remaining = (cs: Credential[], key: string) => poolSummary(cs, key, poolShares([], cs, key, [])).remaining;
    const spec = { provider: 'claude', windowKey: 'five_hour', scope: 'pool' as const };
    const snapshot = { fetchedAt: '', strategy: 'soonest-reset', credentials: creds };
    // Plain average would read 55% used; by plan it is 100 - 75.
    expect(readTray(spec, snapshot, remaining).usedPercent).toBeCloseTo(25);
  });
});

describe('project: routing', () => {
  it('soonest-reset drains the account whose weekly window resets first, even on the 5-hour view', () => {
    const early = account('early', [win('five_hour', 0, 4 * H, FIVE_H), win('seven_day', 0, 24 * H, WEEK)]);
    const late = account('late', [win('five_hour', 0, H, FIVE_H), win('seven_day', 0, 96 * H, WEEK)]);
    const p = run([late, early], 'five_hour', 10, 'soonest-reset');
    // All drain goes to "early": 2.5% of the pool (5% of its window) a step until its 4h reset.
    expect(p.points[4]!.remaining).toBeCloseTo(90);
    expect(p.nextReset).toEqual({ at: NOW + 4 * H, restores: 37.5 });
  });
  it('reports the reset at its own time, not the step after it', () => {
    const p = run([weekly('soon', 50, 2 * H + 7 * 60_000), weekly('late', 0, 100 * H)], 'seven_day', 0, 'soonest-reset');
    expect(p.nextReset).toEqual({ at: NOW + 2 * H + 7 * 60_000, restores: 25 });
  });
  it('every strategy uses the highest priority tier first', () => {
    const accounts = [weekly('a', 0, 2 * H), weekly('b', 0, 50 * H, { priority: 1 })];
    // "a" resets first but sits in the lower tier, so it stays unused.
    expect(run(accounts, 'seven_day', 5, 'soonest-reset').nextReset).toBeNull();
    expect(run(accounts, 'seven_day', 5, 'round-robin').nextReset).toBeNull();
  });
  it('fill-first drains the first account by ID in the top tier', () => {
    const p = run([weekly('b', 0, 50 * H), weekly('a', 0, 2 * H)], 'seven_day', 20, 'fill-first');
    // "a" takes every step before its 2h reset: 7 steps of 10% of its window.
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 35 });
  });
  it('round-robin splits drain evenly and passes a full account\'s share on', () => {
    const p = run([weekly('a', 95, null), weekly('b', 0, null), weekly('c', 0, null)], 'seven_day', 8, 'round-robin');
    // "a" fills after 5% of its window; b and c take the rest, so the pool still drops 8 in an hour.
    expect(p.points[4]!.remaining).toBeCloseTo(205 / 3 - 8);
  });
  it('round-robin sends equal use to each plan, so a Pro window fills five times faster than Max 5x', () => {
    const creds = [
      account('max', [win('five_hour', 0, 50 * H, FIVE_H)], { plan: MAX_5X }),
      account('pro', [win('five_hour', 0, 2 * H, FIVE_H)], { plan: PRO }),
    ];
    // 1.5% of the pool a step, half each: Pro's half is 4.5% of its window (6 x 0.75).
    expect(run(creds, 'five_hour', 6, 'round-robin').nextReset).toEqual({ at: NOW + 2 * H, restores: (7 * 4.5) / 6 });
  });
  it('weighted round robin splits by weight and skips weight 0; plain round robin ignores weights', () => {
    const accounts = [weekly('a', 0, 2 * H, { weight: 3 }), weekly('b', 0, 100 * H), weekly('c', 0, H, { weight: 0 })];
    // 1.5% of the pool a step: "a" gets 3/4 for the 7 steps before its 2h reset.
    expect(run(accounts, 'seven_day', 6, 'weighted-round-robin').nextReset?.restores).toBeCloseTo(7 * 1.125);
    // Even thirds; "c" resets first, after 3 steps.
    expect(run(accounts, 'seven_day', 6, 'round-robin').nextReset?.restores).toBeCloseTo(1.5);
  });
  it('the preferred account takes drain ahead of the strategy', () => {
    expect(run([weekly('a', 0, 2 * H), weekly('b', 0, 50 * H, { preferred: true })], 'seven_day', 5, 'soonest-reset').nextReset).toBeNull();
  });
  it('a benched account takes no drain until its cooldown ends', () => {
    const accounts = [weekly('a', 0, 2 * H, { cooldownUntil: iso(NOW + 3 * H) }), weekly('b', 0, 50 * H)];
    expect(run(accounts, 'seven_day', 5, 'soonest-reset').nextReset).toBeNull();
  });
});

describe('project: coupled windows', () => {
  const half = (cost: Record<string, number>): AccountShare => ({ share: 0.5, cost });
  it('a full 5-hour window stops an account taking weekly drain', () => {
    const capped = account('capped', [win('five_hour', 95, 4 * H, FIVE_H), win('seven_day', 0, 2 * H, WEEK)]);
    const spare = account('spare', [win('five_hour', 0, null, FIVE_H), win('seven_day', 0, 96 * H, WEEK)]);
    // 1% of the pool is 2% of an account's week and 10% of its session window.
    const shares = new Map([['capped', half({ seven_day: 2, five_hour: 10 })], ['spare', half({ seven_day: 2, five_hour: 10 })]]);
    const p = project([capped, spare], 'seven_day', 2, NOW, 1, 'soonest-reset', shares);
    // "capped" has room for one 0.5% step (5% of its session window).
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 0.5 });
    expect(at(p, NOW + H)).toBeCloseTo(98);
  });
  it('a full weekly window stops an account taking 5-hour drain', () => {
    const capped = account('capped', [win('five_hour', 0, null, FIVE_H), win('seven_day', 99, 96 * H, WEEK)]);
    const spare = account('spare', [win('five_hour', 0, null, FIVE_H), win('seven_day', 0, 120 * H, WEEK)]);
    const shares = new Map([['capped', half({ five_hour: 2, seven_day: 0.4 })], ['spare', half({ five_hour: 2, seven_day: 0.4 })]]);
    const p = project([capped, spare], 'five_hour', 10, NOW, 1, 'soonest-reset', shares);
    // "capped" takes one 2.5% step (1% of its week), starting its 5-hour window then.
    expect(p.nextReset).toEqual({ at: NOW + STEP + FIVE_H, restores: 2.5 });
  });
  it('without a measured ratio the other window does not cap', () => {
    const capped = account('capped', [win('five_hour', 100, 4 * H, FIVE_H), win('seven_day', 0, 2 * H, WEEK)]);
    expect(run([capped], 'seven_day', 4, 'soonest-reset').nextReset).toEqual({ at: NOW + 2 * H, restores: 7 });
  });
});

describe('project: reset cadence', () => {
  // "a" refills at 2h, then idles while higher-tier "b" takes the drain until it fills at 10h.
  const after = (cadence: LimitWindow['resetCadence']) => run([
    account('a', [win('seven_day', 50, 2 * H, WEEK, { resetCadence: cadence })]),
    account('b', [win('seven_day', 90, null, WEEK)], { priority: 1 }),
  ], 'seven_day', 0.5, 'soonest-reset', 8);
  const refilled = 0.5 * (100 - 0.25);
  it('a fixed-cadence window resets one period after its last reset, used or not', () => {
    expect(at(after('fixed'), NOW + 2 * H + WEEK)).toBeCloseTo(refilled);
  });
  it('an on-use window starts its next period with its first use after the reset', () => {
    const p = after('on_use');
    expect(at(p, NOW + 2 * H + WEEK)).toBe(0);
    expect(at(p, NOW + 10 * H + STEP + WEEK)).toBeCloseTo(refilled);
  });
  it('an unused window with no reset starts on its first use', () => {
    const p = run([account('a', [win('five_hour', 0, null, FIVE_H)])], 'five_hour', 10, 'soonest-reset');
    expect(p.nextReset?.at).toBe(NOW + STEP + FIVE_H);
  });
});

describe('project: edges / depletionAt', () => {
  it('drains to exactly zero', () => {
    expect(depletionAt(run([weekly('a', 90, null)], 'seven_day', 10, 'soonest-reset').points)).toBe(NOW + H);
  });
  it('stays flat without drain', () => {
    const p = run([weekly('a', 30, null)], 'seven_day', 0, 'soonest-reset');
    expect(new Set(p.points.map((x) => x.remaining))).toEqual(new Set([70]));
  });
  it('finds the first empty point', () => {
    expect(depletionAt([{ t: 1, remaining: 5 }, { t: 2, remaining: 0 }])).toBe(2);
    expect(depletionAt([{ t: 1, remaining: 5 }])).toBeNull();
  });
});
