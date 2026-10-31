import { describe, expect, it } from 'vitest';
import type { Credential, CredentialPlan, LimitWindow } from '@shared/types';
import { readTray } from '@shared/trayValues';
import { poolSummary, poolWindowKey, project } from './forecast';
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
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  weight: 1, plan: null, resetCredits: null, windows, ...patch,
});
/** Weekly account with an idle 5-hour window: `used` percent, resetting `resetIn` from NOW. */
const weekly = (id: string, used: number, resetIn: number | null, patch: Partial<Credential> = {}) =>
  account(id, [win('five_hour', 10, null, FIVE_H), win('seven_day', used, resetIn, WEEK)], patch);
/** Projects with shares from plans alone (no history): same-plan accounts split the pool evenly. */
const run = (creds: Credential[], key: string, perHour: number, strategy: string, days = 1) =>
  project(creds, key, perHour, NOW, days * 24, strategy, poolShares([], creds, key, []));
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
    expect(p.nextReset).toEqual({ at: NOW + 4 * H, restores: 40 });
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
    // "a" takes every step before its 2h reset: 8 steps of 10% of its window.
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 40 });
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
    expect(run(creds, 'five_hour', 6, 'round-robin').nextReset).toEqual({ at: NOW + 2 * H, restores: (8 * 4.5) / 6 });
  });
  it('weighted round robin splits by weight and skips weight 0; plain round robin ignores weights', () => {
    const accounts = [weekly('a', 0, 2 * H, { weight: 3 }), weekly('b', 0, 100 * H), weekly('c', 0, H, { weight: 0 })];
    // 1.5% of the pool a step: "a" gets 3/4 for the 8 steps before its 2h reset.
    expect(run(accounts, 'seven_day', 6, 'weighted-round-robin').nextReset?.restores).toBeCloseTo(8 * 1.125);
    // Even thirds; "c" resets first, after 4 steps.
    expect(run(accounts, 'seven_day', 6, 'round-robin').nextReset?.restores).toBeCloseTo(2);
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
    const p = project([capped, spare], 'seven_day', 2, NOW, 24, 'soonest-reset', shares);
    // "capped" has room for one 0.5% step (5% of its session window).
    expect(p.nextReset).toEqual({ at: NOW + 2 * H, restores: 0.5 });
    expect(at(p, NOW + H)).toBeCloseTo(98);
  });
  it('a full weekly window stops an account taking 5-hour drain', () => {
    const capped = account('capped', [win('five_hour', 0, null, FIVE_H), win('seven_day', 99, 96 * H, WEEK)]);
    const spare = account('spare', [win('five_hour', 0, null, FIVE_H), win('seven_day', 0, 120 * H, WEEK)]);
    const shares = new Map([['capped', half({ five_hour: 2, seven_day: 0.4 })], ['spare', half({ five_hour: 2, seven_day: 0.4 })]]);
    const p = project([capped, spare], 'five_hour', 10, NOW, 24, 'soonest-reset', shares);
    // "capped" takes one 2.5% step (1% of its week), starting its 5-hour window at NOW.
    expect(p.nextReset).toEqual({ at: NOW + FIVE_H, restores: 2.5 });
  });
  it('without a measured ratio the other window does not cap', () => {
    const capped = account('capped', [win('five_hour', 100, 4 * H, FIVE_H), win('seven_day', 0, 2 * H, WEEK)]);
    expect(run([capped], 'seven_day', 4, 'soonest-reset').nextReset).toEqual({ at: NOW + 2 * H, restores: 8 });
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
    expect(at(after('fixed'), NOW + 2 * H + WEEK)).toBe(50);
  });
  it('an on-use window starts its next period with its first use after the reset', () => {
    const p = after('on_use');
    expect(at(p, NOW + 2 * H + WEEK)).toBe(0);
    expect(at(p, NOW + 10 * H + WEEK)).toBe(50);
    expect(at(p, NOW + 10 * H + STEP + WEEK)).toBeCloseTo(refilled);
  });
  it('an unused window with no reset starts on its first use', () => {
    const p = run([account('a', [win('five_hour', 0, null, FIVE_H)])], 'five_hour', 10, 'soonest-reset');
    expect(p.nextReset?.at).toBe(NOW + FIVE_H);
  });
});

describe('project: edges', () => {
  it('drains to exactly zero', () => {
    const p = run([weekly('a', 90, null)], 'seven_day', 10, 'soonest-reset');
    expect(p.points.find((x) => x.remaining <= 0)?.t).toBe(NOW + H);
  });
  it('stays flat without drain', () => {
    const p = run([weekly('a', 30, null)], 'seven_day', 0, 'soonest-reset');
    expect(new Set(p.points.map((x) => x.remaining))).toEqual(new Set([70]));
  });
});

describe('project: account forecasts and stuck', () => {
  it.each(['fill-first', 'soonest-reset', 'round-robin', 'weighted-round-robin'])('one account agrees with stuck under %s', (strategy) => {
    const p = run([account('a', [win('five_hour', 60, 4 * H, FIVE_H)])], 'five_hour', 40, strategy);
    expect(p.accounts.get('a')).toEqual({ runsOutAt: NOW + H, endsAtPercent: 100 });
    expect(p.stuck?.blockers[0]?.until).toBe(p.stuck?.until);
    expect(p.stuck).toEqual({ at: NOW + H, until: NOW + 4 * H, blockers: [{ credentialId: 'a', windowKey: 'five_hour', until: NOW + 4 * H }] });
  });
  it.each(['fill-first', 'soonest-reset', 'round-robin', 'weighted-round-robin'])('keeps exhaustion before an intra-step reset under %s', (strategy) => {
    const p = run([account('a', [win('five_hour', 99, H / 6, FIVE_H)])], 'five_hour', 12, strategy);
    expect(p.accounts.get('a')).toEqual({ runsOutAt: NOW + H / 12, endsAtPercent: 100 });
    expect(p.stuck).toEqual({ at: NOW + H / 12, until: NOW + H / 6, blockers: [{ credentialId: 'a', windowKey: 'five_hour', until: NOW + H / 6 }] });
    expect(p.points[1]).toEqual({ t: NOW + STEP, remaining: 99 });
  });
  it.each(['fill-first', 'soonest-reset', 'round-robin', 'weighted-round-robin'])('keeps forecast scope independent of chart hours under %s', (strategy) => {
    const creds = [account('a', [win('seven_day', 0, H, WEEK), win('five_hour', 0, null, FIVE_H, { resetCadence: 'on_use' })])];
    const shares = new Map([['a', { share: 1, cost: { seven_day: 1, five_hour: 1 } }]]);
    const short = project(creds, 'seven_day', 40, NOW, 1, strategy, shares);
    const long = project(creds, 'seven_day', 40, NOW, 168, strategy, shares);
    expect(short.accounts).toEqual(long.accounts);
    expect(short.stuck).toEqual(long.stuck);
    expect(short.accounts.get('a')).toEqual({ runsOutAt: null, endsAtPercent: 40 });
    expect(short.stuck).toBeNull();
    expect(short.points).toHaveLength(5);
    expect(long.points).toHaveLength(673);
  });
  it.each(['fill-first', 'soonest-reset', 'round-robin', 'weighted-round-robin'])('routes multiple accounts before an intra-step reset under %s', (strategy) => {
    const creds = [account('a', [win('five_hour', 99, H / 5, FIVE_H)]), account('b', [win('five_hour', 99, H / 3, FIVE_H)], { weight: 3 })];
    const p = run(creds, 'five_hour', 6, strategy);
    expect(Math.max(...[...p.accounts.values()].map((a) => a.runsOutAt!))).toBe(NOW + H / 6);
    expect([...p.accounts.values()].map((a) => a.endsAtPercent)).toEqual([100, 100]);
    expect(p.stuck).toEqual({ at: NOW + H / 6, until: NOW + H / 5, blockers: [
      { credentialId: 'a', windowKey: 'five_hour', until: NOW + H / 5 },
      { credentialId: 'b', windowKey: 'five_hour', until: NOW + H / 3 },
    ] });
  });
  it.each(['fill-first', 'soonest-reset', 'round-robin', 'weighted-round-robin'])('keeps multiple account scopes independent of chart hours under %s', (strategy) => {
    const creds = ['a', 'b'].map((id, i) => account(id, [win('seven_day', 0, (i + 1) * H, WEEK), win('five_hour', 0, null, FIVE_H, { resetCadence: 'on_use' })]));
    const shares = new Map(creds.map((c) => [c.id, { share: 0.5, cost: { seven_day: 2, five_hour: 2 } }]));
    const short = project(creds, 'seven_day', 40, NOW, 1, strategy, shares);
    const long = project(creds, 'seven_day', 40, NOW, 168, strategy, shares);
    expect(short.accounts).toEqual(long.accounts);
    expect(short.stuck).toEqual(long.stuck);
    expect(short.stuck).toBeNull();
  });
  it('only spends after an intra-step cooldown expires', () => {
    const p = run([account('a', [win('five_hour', 0, H, FIVE_H)], { cooldownUntil: iso(NOW + 7 * 60_000) })], 'five_hour', 60, 'fill-first');
    expect(p.accounts.get('a')).toEqual({ runsOutAt: null, endsAtPercent: 53 });
    expect(p.points[1]).toEqual({ t: NOW + STEP, remaining: 92 });
    expect(p.stuck).toEqual({ at: NOW, until: NOW + 7 * 60_000, blockers: [{ credentialId: 'a', windowKey: null, until: NOW + 7 * 60_000 }] });
  });
  it('does not report an empty pool as stuck', () => {
    expect(run([], 'five_hour', 0, 'fill-first').stuck).toBeNull();
  });
  it('reports an already exhausted pool without recent drain', () => {
    const p = run([account('a', [win('five_hour', 100, H, FIVE_H)])], 'five_hour', 0, 'fill-first');
    expect(p.accounts.get('a')?.runsOutAt).toBe(NOW);
    expect(p.stuck).toEqual({ at: NOW, until: NOW + H, blockers: [{ credentialId: 'a', windowKey: 'five_hour', until: NOW + H }] });
  });
  it.each([
    ['only a weekly window', [win('seven_day', 0, WEEK, WEEK)]],
    ['an API-key credential without limits', []],
    ['unknown window usage', [win('five_hour', null, H, FIVE_H)]],
  ] as const)('does not report stuck when an enabled credential has %s', (_label, windows) => {
    const p = run([account('a', [win('five_hour', 100, H, FIVE_H)]), account('b', [...windows])], 'five_hour', 0, 'fill-first');
    expect(p.accounts.has('b')).toBe(false);
    expect(p.accounts.get('a')?.runsOutAt).toBe(NOW);
    expect(p.stuck).toBeNull();
  });
  it('does not report stuck when an enabled credential has no share', () => {
    const creds = ['a', 'b'].map((id) => account(id, [win('five_hour', 100, H, FIVE_H)]));
    const p = project(creds, 'five_hour', 0, NOW, 24, 'fill-first', new Map([['a', { share: 1, cost: { five_hour: 1 } }]]));
    expect(p.accounts.has('b')).toBe(false);
    expect(p.stuck).toBeNull();
  });
  it('reports stuck despite an unprojected disabled credential', () => {
    const p = run([account('a', [win('five_hour', 100, H, FIVE_H)]), account('b', [], { disabled: true })], 'five_hour', 0, 'fill-first');
    expect(p.accounts.has('b')).toBe(false);
    expect(p.stuck).toEqual({ at: NOW, until: NOW + H, blockers: [{ credentialId: 'a', windowKey: 'five_hour', until: NOW + H }] });
  });
  it('fill-first fills one account before the pool becomes stuck', () => {
    const p = run([account('a', [win('five_hour', 80, 4 * H, FIVE_H)]), account('b', [win('five_hour', 0, 4 * H, FIVE_H)])], 'five_hour', 10, 'fill-first');
    expect(p.accounts.get('a')?.runsOutAt).toBe(NOW + H);
    expect(p.stuck).toBeNull();
  });
  it('covers account resets beyond the chart, freezing forecasts at the first reset', () => {
    const creds = [account('a', [win('five_hour', 10, 4 * H, FIVE_H)])];
    const p = project(creds, 'five_hour', 10, NOW, 1, 'fill-first', poolShares([], creds, 'five_hour', []));
    expect(p.points).toHaveLength(5);
    expect(p.accounts.get('a')).toEqual({ runsOutAt: null, endsAtPercent: 50 });
    expect(p.nextReset).toBeNull();
  });
  it('finds recovery at the weekly reset across a 5-hour model, outside the chart', () => {
    const creds = [account('a', [win('five_hour', 0, 4 * H, FIVE_H), win('seven_day', 99, 96 * H + 7 * 60_000, WEEK)])];
    const shares = new Map([['a', { share: 1, cost: { five_hour: 1, seven_day: 1 } }]]);
    const p = project(creds, 'five_hour', 4, NOW, 1, 'fill-first', shares);
    expect(p.stuck).toEqual({ at: NOW + STEP, until: NOW + 96 * H + 7 * 60_000, blockers: [{ credentialId: 'a', windowKey: 'seven_day', until: NOW + 96 * H + 7 * 60_000 }] });
    expect(p.accounts.get('a')).toEqual({ runsOutAt: null, endsAtPercent: 1 });
    expect(p.points).toHaveLength(5);
  });
  it.each(['fill-first', 'soonest-reset', 'round-robin', 'weighted-round-robin'])('two accounts route through exhaustion under %s', (strategy) => {
    const creds = [account('a', [win('five_hour', 80, 4 * H, FIVE_H)]), account('b', [win('five_hour', 0, 4 * H, FIVE_H)], { weight: 3 })];
    const p = run(creds, 'five_hour', 40, strategy);
    expect(p.stuck?.at).toBe(NOW + 1.5 * H);
    expect(p.accounts.get('a')?.runsOutAt).not.toBeNull();
    expect(p.accounts.get('b')?.runsOutAt).toBe(p.stuck?.at);
  });
  it('waits until all caps and cooldown permit use, rather than reporting the first reset', () => {
    const creds = [account('a', [win('five_hour', 100, H, FIVE_H), win('seven_day', 100, 2 * H, WEEK)], { cooldownUntil: iso(NOW + 3 * H + 7 * 60_000) })];
    const shares = new Map([['a', { share: 1, cost: { five_hour: 1, seven_day: 1 } }]]);
    const p = project(creds, 'five_hour', 1, NOW, 1, 'fill-first', shares);
    expect(p.stuck).toEqual({ at: NOW, until: NOW + 3 * H + 7 * 60_000, blockers: [{ credentialId: 'a', windowKey: null, until: NOW + 3 * H + 7 * 60_000 }] });
  });
  it('leaves recovery unknown when no account can regain room', () => {
    const p = run([account('a', [win('five_hour', 100, null, FIVE_H)])], 'five_hour', 1, 'fill-first');
    expect(p.accounts.get('a')?.runsOutAt).toBe(NOW);
    expect(p.stuck).toEqual({ at: NOW, until: null, blockers: [{ credentialId: 'a', windowKey: 'five_hour', until: null }] });
  });
  it('traces weekly exhaustion followed by another account filling a later 5-hour window', () => {
    const creds = [
      account('a', [win('seven_day', 80, 20 * H, WEEK), win('five_hour', 0, H, FIVE_H, { resetCadence: 'on_use' })]),
      account('b', [win('seven_day', 0, 24 * H, WEEK), win('five_hour', 0, H, FIVE_H, { resetCadence: 'on_use' })]),
    ];
    const shares = new Map([
      ['a', { share: 0.5, cost: { seven_day: 2, five_hour: 1 } }],
      ['b', { share: 0.5, cost: { seven_day: 2, five_hour: 10 } }],
    ]);
    const p = project(creds, 'seven_day', 5, NOW, 24, 'fill-first', shares);
    expect(p.accounts.get('a')?.runsOutAt).toBe(NOW + 2 * H);
    expect(p.accounts.get('b')?.runsOutAt).toBeNull();
    expect(p.stuck).toEqual({ at: NOW + 4 * H, until: NOW + 7 * H, blockers: [
      { credentialId: 'a', windowKey: 'seven_day', until: NOW + 20 * H },
      { credentialId: 'b', windowKey: 'five_hour', until: NOW + 7 * H },
    ] });
  });
  it('records a cooldown still benching an account when another account exhausts', () => {
    const creds = [
      account('b', [win('five_hour', 0, 4 * H, FIVE_H)], { cooldownUntil: iso(NOW + 2 * H) }),
      account('a', [win('five_hour', 80, 4 * H, FIVE_H)]),
    ];
    expect(run(creds, 'five_hour', 10, 'fill-first').stuck).toEqual({ at: NOW + H, until: NOW + 2 * H, blockers: [
      { credentialId: 'b', windowKey: null, until: NOW + 2 * H },
      { credentialId: 'a', windowKey: 'five_hour', until: NOW + 4 * H },
    ] });
  });
  it('uses the last lifting full window at now, including an unknown reset', () => {
    const creds = [account('a', [win('five_hour', 100, H, FIVE_H), win('seven_day', 100, 2 * H, WEEK)])];
    const shares = new Map([['a', { share: 1, cost: { five_hour: 1, seven_day: 1 } }]]);
    const p = project(creds, 'five_hour', 0, NOW, 1, 'fill-first', shares);
    expect(p.stuck).toEqual({ at: NOW, until: NOW + 2 * H, blockers: [
      { credentialId: 'a', windowKey: 'seven_day', until: NOW + 2 * H },
    ] });
    expect(p.stuck?.blockers[0]?.until).toBe(p.stuck?.until);
    creds[0]!.windows[1]!.resetsAt = null;
    expect(project(creds, 'five_hour', 0, NOW, 1, 'fill-first', shares).stuck).toEqual({ at: NOW, until: null, blockers: [
      { credentialId: 'a', windowKey: 'seven_day', until: null },
    ] });
  });
  it('omits weight-zero non-preferred accounts from weighted blockers', () => {
    const creds = [
      account('b', [win('five_hour', 0, H, FIVE_H)], { weight: 0 }),
      account('a', [win('five_hour', 100, 2 * H, FIVE_H)], { weight: 0, preferred: true }),
    ];
    expect(run(creds, 'five_hour', 0, 'weighted-round-robin').stuck).toEqual({ at: NOW, until: NOW + 2 * H, blockers: [
      { credentialId: 'a', windowKey: 'five_hour', until: NOW + 2 * H },
    ] });
  });
  it('does not mistake rounding residue for a stuck pool', () => {
    const creds = ['a', 'b', 'c'].map((id, i) => account(id, [win('five_hour', 0, 4 * H, FIVE_H)], { weight: i + 1 }));
    expect(run(creds, 'five_hour', 0.7, 'weighted-round-robin').stuck).toBeNull();
  });

});
