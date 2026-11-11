import { describe, expect, it } from 'vitest';
import { emptyCounts } from '@shared/activityCounts';
import type { ActivityBucket, Credential, CredentialPlan, HistorySample } from '@shared/types';
import { measuredSessionUsd, poolShares } from './poolCapacity';
import { poolSummary, project } from './forecast';
import { pastSeries } from './poolHistory';
import { poolSegments } from './poolWindows';
import { readTray } from '@shared/trayValues';

const H = 3_600_000;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const MAX_5X: CredentialPlan = { tier: 'default_claude_max_5x', label: 'Max 5x', multiplier: 5 };
const PRO: CredentialPlan = { tier: 'default_claude_ai', label: 'Pro', multiplier: 1 };
const account = (id: string, plan: CredentialPlan | null): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  weight: 1, plan, resetCredits: null,
  windows: [
    { key: 'five_hour', label: '5-hour', usedPercent: 0, resetsAt: null, status: 'allowed', durationMs: 5 * H, scoped: false, resetCadence: 'on_use' },
    { key: 'seven_day', label: 'Weekly', usedPercent: 0, resetsAt: null, status: 'allowed', durationMs: 168 * H, scoped: false, resetCadence: 'fixed' },
  ],
});
const at = (t: number, used: HistorySample['used']): HistorySample => ({ at: new Date(t).toISOString(), used });

describe('poolShares', () => {
  it('sizes the 5-hour pool by plan multiple', () => {
    const shares = poolShares([], [account('max', MAX_5X), account('pro', PRO)], 'five_hour', []);
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
    const shares = poolShares(samples, [account('max', MAX_5X), account('pro', PRO)], 'seven_day', []);
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
    const shares = poolShares(samples, [account('max', MAX_5X), account('pro', PRO)], 'seven_day', []);
    expect(shares.get('max')!.share).toBeCloseTo(50 / 60);
  });
  it('without any measured ratio, weights by plan and leaves the windows uncoupled', () => {
    const shares = poolShares([], [account('max', MAX_5X), account('pro', PRO)], 'seven_day', []);
    expect(shares.get('max')!.share).toBeCloseTo(5 / 6);
    expect(shares.get('max')!.cost.five_hour).toBeUndefined();
  });
  it('treats an unknown plan as Pro-sized', () => {
    const shares = poolShares([], [account('a', null), account('b', null)], 'five_hour', []);
    expect(shares.get('a')!.share).toBe(0.5);
  });
});

describe('usable pooled quota', () => {
  const samples = [
    at(NOW - 2 * H, { max: { five_hour: 0, seven_day: 0 }, pro: { five_hour: 0, seven_day: 0 } }),
    at(NOW - H, { max: { five_hour: 35, seven_day: 5 }, pro: { five_hour: 50, seven_day: 5 } }),
  ];
  const credentials = () => {
    const max = account('max', MAX_5X);
    const pro = account('pro', PRO);
    max.windows[0]!.usedPercent = 20;
    max.windows[1]!.usedPercent = 99;
    pro.windows[0]!.usedPercent = 40;
    pro.windows[1]!.usedPercent = 98;
    return [max, pro];
  };
  // Weekly quota allows 7% of Max's session and 20% of Pro's: (5 × 7 + 1 × 20) / 6.
  const remaining = (5 * 7 + 20) / 6;

  it('converts each account weekly remainder before adding fixed plan-weighted session contributions', () => {
    const creds = credentials();
    const shares = poolShares(samples, creds, 'five_hour', []);
    expect(shares.get('max')!.share).toBeCloseTo(5 / 6);
    expect(shares.get('pro')!.share).toBeCloseTo(1 / 6);
    expect(poolSummary(creds, 'five_hour', shares).remaining).toBeCloseTo(remaining);
    const segments = poolSegments(creds, 'five_hour', shares);
    expect(segments[0]!.usedPercent).toBeCloseTo(93);
    expect(segments[1]!.usedPercent).toBeCloseTo(80);
    expect(segments.every((s) => !s.rejected)).toBe(true);
    const current = at(NOW, { max: { five_hour: 20, seven_day: 99 }, pro: { five_hour: 40, seven_day: 98 } });
    expect(pastSeries([current], creds, 'five_hour', 0, shares)[0]!.remaining).toBeCloseTo(remaining);
    const projection = project(creds, 'five_hour', 1, NOW, 1, 'round-robin', shares);
    expect(projection.points[0]!.remaining).toBeCloseTo(remaining);
    expect(projection.points.at(-1)!.remaining).toBeCloseTo(remaining - 1);
    const tray = readTray({ provider: 'claude', windowKey: 'five_hour', scope: 'pool' },
      { fetchedAt: '', strategy: '', credentials: creds },
      (cs, key) => poolSummary(cs, key, poolShares(samples, cs, key, [])).remaining);
    expect(tray.usedPercent).toBeCloseTo(100 - remaining);
  });

  it('keeps the session remainder when it is smaller than the converted weekly remainder', () => {
    const creds = credentials();
    creds[0]!.windows[0]!.usedPercent = 98;
    creds[1]!.windows[0]!.usedPercent = 95;
    expect(poolSummary(creds, 'five_hour', poolShares(samples, creds, 'five_hour', [])).remaining).toBeCloseTo((5 * 2 + 5) / 6);
  });

  it('keeps weekly quota independent of session windows that can refill', () => {
    const creds = credentials();
    for (const c of creds) c.windows[0]!.usedPercent = 100;
    // Weekly capacities are 35 and 10 Pro sessions; their remaining fractions are 1% and 2%.
    expect(poolSummary(creds, 'seven_day', poolShares(samples, creds, 'seven_day', [])).remaining).toBeCloseTo((35 + 10 * 2) / 45);
  });

  it('retains session weighting without inventing a missing weekly conversion ratio', () => {
    const creds = credentials();
    const shares = poolShares([], creds, 'five_hour', []);
    expect(poolSummary(creds, 'five_hour', shares).remaining).toBeCloseTo((5 * 80 + 60) / 6);
    for (const c of creds) c.windows[1]!.usedPercent = 100;
    expect(poolSummary(creds, 'five_hour', shares).remaining).toBe(0);
  });
});

describe('measured session sizes', () => {
  const TEAM: CredentialPlan = { tier: 'claude_team', label: 'Team', multiplier: null };
  const bucket = (id: string, start: number, costUsd: number): ActivityBucket => ({
    ...emptyCounts(), start, wholeDay: false, provider: 'claude', authIndex: id, model: 'm', client: null, requests: 1, costUsd,
  });
  // Over one logged hour, each account's 5-hour window moves `moved` percent while it spends `usd`.
  const hour = (moves: Record<string, [moved: number, usd: number]>) => ({
    samples: [
      at(NOW - H, Object.fromEntries(Object.keys(moves).map((id) => [id, { five_hour: 0, seven_day: 0 }]))),
      at(NOW, Object.fromEntries(Object.entries(moves).map(([id, [moved]]) => [id, { five_hour: moved, seven_day: 0 }]))),
    ],
    buckets: Object.entries(moves).map(([id, [, usd]]) => bucket(id, NOW - H, usd)),
  });

  it('is the cost per full window, once the window moved enough', () => {
    const { samples, buckets } = hour({ a: [25, 5], b: [10, 5] });
    expect(measuredSessionUsd(samples, buckets, account('a', null), 'five_hour')).toBeCloseTo(20);
    expect(measuredSessionUsd(samples, buckets, account('b', null), 'five_hour')).toBeNull();
  });
  it('sizes a plan without a published multiple against a known plan in the pool', () => {
    // Pro spends $10 per window; Team spends $40, so it holds 4 Pro sessions.
    const { samples, buckets } = hour({ pro: [50, 5], team: [25, 10] });
    const shares = poolShares(samples, [account('pro', PRO), account('team', TEAM)], 'five_hour', buckets);
    expect(shares.get('team')!.share).toBeCloseTo(4 / 5);
  });
  it('compares measured dollars directly in a pool with no known plan', () => {
    const { samples, buckets } = hour({ a: [50, 10], b: [50, 30], c: [0, 0] });
    const shares = poolShares(samples, [account('a', null), account('b', null), account('c', null)], 'five_hour', buckets);
    // a $20, b $60, unmeasured c takes the mean, $40.
    expect(shares.get('b')!.share).toBeCloseTo(60 / 120);
    expect(shares.get('c')!.share).toBeCloseTo(40 / 120);
  });
  it('keeps the published multiple over a measurement', () => {
    const { samples, buckets } = hour({ max: [50, 100], pro: [50, 5] });
    expect(poolShares(samples, [account('max', MAX_5X), account('pro', PRO)], 'five_hour', buckets).get('max')!.share).toBeCloseTo(5 / 6);
  });
});
