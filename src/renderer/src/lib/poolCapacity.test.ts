import { describe, expect, it } from 'vitest';
import { emptyCounts } from '@shared/activityCounts';
import type { ActivityBucket, Credential, CredentialPlan, HistorySample } from '@shared/types';
import { consumedBetween } from '@shared/usageWindows';
import { measuredSessionUsd, poolShares, preparePoolEvidence } from './poolCapacity';
import { poolSummary, project } from './forecast';
import { pastSeries } from './poolHistory';
import { poolSegments } from './poolWindows';
import { readTray } from '@shared/trayValues';

const H = 3_600_000;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const MAX_5X: CredentialPlan = { tier: 'default_claude_max_5x', label: 'Max 5x', multiplier: 5 };
const PRO: CredentialPlan = { tier: 'default_claude_ai', label: 'Pro', multiplier: 1 };
const account = (id: string, plan: CredentialPlan | null): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false, canRefresh: true,
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

  it('matches interval-by-interval costing across randomized samples and buckets', () => {
    const session = 'five_hour';
    const accounts = ['a', 'b', 'missing'].map((id) => account(id, null));
    let seed = 42;
    const random = () => {
      seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    const naive = (samples: HistorySample[], buckets: ActivityBucket[], c: Credential) => {
      const hourly = buckets.filter((b) => !b.wholeDay);
      const loggedFrom = Math.min(...hourly.map((b) => b.start));
      const relevant = samples.map((sample) => ({ sample, time: Date.parse(sample.at) }))
        .filter(({ sample, time }) => time >= loggedFrom && sample.used[c.id]?.[session] !== undefined)
        .sort((a, b) => a.time - b.time);
      let percent = 0;
      let usd = 0;
      for (let i = 1; i < relevant.length; i++) {
        const prev = relevant[i - 1]!;
        const next = relevant[i]!;
        percent += consumedBetween(prev.sample, next.sample, c.id, session) ?? 0;
        for (const b of hourly) {
          if (b.authIndex !== c.authIndex) continue;
          const overlap = Math.min(next.time, b.start + H) - Math.max(prev.time, b.start);
          if (overlap > 0) usd += (b.costUsd * overlap) / H;
        }
      }
      return percent >= 20 && usd > 0 ? 100 * (usd / percent) : null;
    };

    for (let trial = 0; trial < 100; trial++) {
      const samples = Array.from({ length: 25 }, () => {
        const time = NOW + Math.floor(random() * 30 - 3) * (H / 4);
        const used = Object.fromEntries(accounts.filter(() => random() > 0.2).map(({ id }) => [id, { [session]: Math.floor(random() * 100) }]));
        const resets = Object.fromEntries(accounts.filter(() => random() > 0.3).map(({ id }) => [id, { [session]: NOW + Math.floor(random() * 8) * H }]));
        return { ...at(time, used), resets };
      });
      const buckets = [{ ...bucket('missing', NOW - H, 100), wholeDay: true }];
      if (trial % 5 !== 0) {
        buckets.push(bucket('b', NOW, 1));
        for (let i = 0; i < 20; i++) {
          const start = NOW + (1 + Math.floor(random() * 6)) * H;
          const id = random() < 0.5 ? 'a' : 'b';
          buckets.push(bucket(id, start, random() * 3), { ...bucket(id, start, random() * 2), model: 'other' });
        }
      }
      for (const c of accounts) {
        const expected = naive(samples, buckets, c);
        const actual = measuredSessionUsd(samples, buckets, c, session);
        if (expected === null) expect(actual).toBeNull();
        else expect(actual).toBeCloseTo(expected, 10);
      }
    }
  });

  it('reuses evidence while normalizing session sizes for each window account set', () => {
    const { samples, buckets } = hour({ pro: [50, 5], max: [50, 100], team: [50, 20] });
    const credentials = [account('pro', PRO), account('max', MAX_5X), account('team', TEAM)];
    credentials[0]!.windows[1]!.usedPercent = null;
    const evidence = preparePoolEvidence(samples, buckets);

    const session = poolShares(samples, credentials, 'five_hour', buckets, evidence);
    const weekly = poolShares(samples, credentials, 'seven_day', buckets, evidence);
    expect(session).toEqual(poolShares(samples, credentials, 'five_hour', buckets));
    expect(weekly).toEqual(poolShares(samples, credentials, 'seven_day', buckets));
    expect(weekly.has('pro')).toBe(false);
    expect(session.get('team')!.share).toBeCloseTo((40 / 25) / (6 + 40 / 25));
    expect(weekly.get('team')!.share).toBeCloseTo(1 / 6);
  });

  it('bounds measuredSessionUsd at the completed-hour cutoff so newer history samples do not dilute frozen costs', () => {
    const samples = [
      at(NOW - H, { a: { five_hour: 0 } }),
      at(NOW, { a: { five_hour: 25 } }),
      // Arrives during the live hour before forecast buckets refresh.
      at(NOW + 15 * 60_000, { a: { five_hour: 100 } }),
    ];
    const buckets = [bucket('a', NOW - H, 1.25)];
    const evidence = preparePoolEvidence(samples, buckets, NOW);
    expect(evidence.measuredSessionUsd(account('a', null), 'five_hour')).toBeCloseTo(5);
  });
});
