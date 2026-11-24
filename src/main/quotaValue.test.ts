import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDay } from '@shared/activityCounts';
import { FIVE_HOUR_MS, MONTH_FROM_WEEK, WEEK_MS } from '@shared/quotaValue';
import type { ActivityEvent, HistorySample } from '@shared/types';
import { openActivityDb, type Db } from './activityDb';
import { estimateQuotaWindows, planReachForCombo, type QuotaCredentialContext } from './quotaValue';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-quota-value-'));
let db: Db;
let seq = 0;

beforeEach(() => {
  db = openActivityDb(path.join(dir, `${seq++}.db`), 'cd'.repeat(32));
});
afterEach(() => db.close());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BASE = new Date(2026, 10, 23, 10, 0, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_MIN = 24 * 60;
const at = (minutes: number) => new Date(BASE + minutes * MIN).toISOString();

function insertReq(minutes: number, patch: Partial<ActivityEvent> & { costUsd?: number }): void {
  const e: ActivityEvent & { costUsd?: number } = {
    at: at(minutes),
    requestId: `q${seq++}`,
    selectionId: null,
    upstreamId: null,
    source: 'proxy',
    provider: 'antigravity',
    model: 'gemini-4-neon',
    effectiveModel: 'gemini-4-neon',
    reasoningEffort: 'medium',
    authIndex: 'ag-1',
    stream: true,
    failed: false,
    statusCode: 200,
    error: null,
    latencyMs: 10,
    ttftMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    sessionId: null,
    movedFrom: null,
    userAgent: null,
    client: 'antigravity-acp',
    ...patch,
  };
  db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)').run(localDay(Date.parse(e.at)), e.failed ? 1 : 0, JSON.stringify(e));
}

function sample(minutes: number, used: HistorySample['used'], resets?: HistorySample['resets']): HistorySample {
  return resets ? { at: at(minutes), used, resets } : { at: at(minutes), used };
}

const agCred: QuotaCredentialContext = {
  id: 'antigravity-a.json',
  authIndex: 'ag-1',
  provider: 'antigravity',
  planLabel: 'Ultra',
  windows: [
    { key: 'ag_summary:gemini-5h', durationMs: FIVE_HOUR_MS, scoped: true },
    { key: 'ag_summary:gemini-weekly', durationMs: WEEK_MS, scoped: true },
    { key: 'ag_summary:3p-5h', durationMs: FIVE_HOUR_MS, scoped: true },
    { key: 'ag_summary:3p-weekly', durationMs: WEEK_MS, scoped: true },
    { key: 'ag:gemini-4-neon-medium', durationMs: FIVE_HOUR_MS, scoped: true },
  ],
};

const claudeCred = (id: string, authIndex: string, planLabel: string): QuotaCredentialContext => ({
  id,
  authIndex,
  provider: 'claude',
  planLabel,
  windows: [
    { key: 'five_hour', durationMs: FIVE_HOUR_MS, scoped: false },
    { key: 'seven_day', durationMs: WEEK_MS, scoped: false },
    { key: 'seven_day_fable', durationMs: WEEK_MS, scoped: true },
  ],
});

describe('estimateQuotaWindows', () => {
  it('computes $/100%, median, IQR and excludes early provider resets', () => {
    const r5A = BASE + 5 * HOUR;
    const rwA = BASE + 7 * 24 * HOUR;
    const r5B = BASE + 10 * HOUR;
    const rwB = BASE + 8 * 24 * HOUR;

    // Interval 1 (0..60): $14 for +10% 5h ($140/5h) and +2.5% wk ($560/wk).
    insertReq(10, { costUsd: 6 });
    insertReq(40, { costUsd: 8 });
    // Reset-crossing stretch (60..120): Google resets early partway through; must be skipped completely.
    insertReq(70, { costUsd: 99 });
    insertReq(110, { costUsd: 5 });
    // Interval 2 (120..180): $15 for +10% 5h ($150/5h) and +2.5% wk ($600/wk).
    insertReq(150, { costUsd: 15 });

    const samples = [
      sample(0, { [agCred.id]: { 'ag_summary:gemini-5h': 10, 'ag_summary:gemini-weekly': 20 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5A, 'ag_summary:gemini-weekly': rwA } }),
      // Flat repeat stays anchored at minute 0.
      sample(30, { [agCred.id]: { 'ag_summary:gemini-5h': 10, 'ag_summary:gemini-weekly': 20 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5A, 'ag_summary:gemini-weekly': rwA } }),
      sample(60, { [agCred.id]: { 'ag_summary:gemini-5h': 20, 'ag_summary:gemini-weekly': 22.5 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5A, 'ag_summary:gemini-weekly': rwA } }),
      // Early reset: both reset timestamps jump and weekly drops from 22.5 -> 4.
      sample(120, { [agCred.id]: { 'ag_summary:gemini-5h': 15, 'ag_summary:gemini-weekly': 4 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5B, 'ag_summary:gemini-weekly': rwB } }),
      sample(180, { [agCred.id]: { 'ag_summary:gemini-5h': 25, 'ag_summary:gemini-weekly': 6.5 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5B, 'ag_summary:gemini-weekly': rwB } }),
    ];

    const out = estimateQuotaWindows(db, { samples, credentials: [agCred] });
    // Per-model ag:* keys are ignored so only summary buckets remain.
    expect(out.map((s) => s.windowKey).sort()).toEqual(['ag_summary:gemini-5h', 'ag_summary:gemini-weekly']);

    const fiveH = out.find((s) => s.windowKey === 'ag_summary:gemini-5h')!.estimate;
    expect(fiveH.intervals).toBe(2);
    expect(fiveH.observedPercent).toBeCloseTo(20);
    expect(fiveH.observedUsd).toBeCloseTo(29);
    expect(fiveH.usdPerFull).toBeCloseTo(145);
    expect(fiveH.medianUsdPerFull).toBeCloseTo(145);
    expect(fiveH.iqr[0]).toBeCloseTo(142.5);
    expect(fiveH.iqr[1]).toBeCloseTo(147.5);
    expect(fiveH.unmatchedIntervals).toBe(0);

    const wk = out.find((s) => s.windowKey === 'ag_summary:gemini-weekly')!.estimate;
    expect(wk.usdPerFull).toBeCloseTo(580);

    const reach = planReachForCombo(out, 'antigravity', 'gemini-4-neon', new Map([['ag-1', 29]]), null)!;
    expect(reach.weekly?.usdPerFull).toBeCloseTo(580);
    expect(reach.monthlyUsd).toBeCloseTo(580 * MONTH_FROM_WEEK);
    expect(reach.plans).toEqual(['Ultra']);
    expect(reach.accounts).toBe(1);
  });

  it('skips cap-clamped 100% jumps, zero-local-spend jumps, unpriced intervals, and pre-retention samples', () => {
    const r5Prev = BASE - DAY_MIN * MIN + 5 * HOUR;
    const r5 = BASE + 5 * HOUR;
    // Earliest retained request is on BASE's day -> previous day's interval must be excluded as pre-retention.
    insertReq(75, { costUsd: 20 }); // Clean interval 60..90: +10% -> $200/5h.
    // Interval 90..120 has $0 local spend -> counted as unmatchedIntervals, excluded from $/100%.
    // Interval 120..150 has an unpriced model -> excluded.
    insertReq(135, { model: 'gemini-unpriced-experimental', effectiveModel: 'gemini-unpriced-experimental', costUsd: undefined });
    // Interval 150..180 hits 100% cap -> excluded so clamping doesn't overstate $/100%.
    insertReq(165, { costUsd: 40 });

    const samples = [
      sample(-DAY_MIN, { [agCred.id]: { 'ag_summary:gemini-5h': 0 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5Prev } }),
      sample(-DAY_MIN + 30, { [agCred.id]: { 'ag_summary:gemini-5h': 10 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5Prev } }),
      sample(60, { [agCred.id]: { 'ag_summary:gemini-5h': 10 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5 } }),
      sample(90, { [agCred.id]: { 'ag_summary:gemini-5h': 20 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5 } }),
      sample(120, { [agCred.id]: { 'ag_summary:gemini-5h': 35 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5 } }),
      sample(150, { [agCred.id]: { 'ag_summary:gemini-5h': 45 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5 } }),
      sample(180, { [agCred.id]: { 'ag_summary:gemini-5h': 100 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5 } }),
    ];

    const out = estimateQuotaWindows(db, { samples, credentials: [agCred] });
    expect(out).toHaveLength(1);
    expect(out[0]!.estimate.usdPerFull).toBeCloseTo(200);
    expect(out[0]!.estimate.intervals).toBe(1);
    expect(out[0]!.estimate.unmatchedIntervals).toBe(1);
  });

  it('attributes Antigravity 3P vs Gemini and Claude Fable vs general weekly buckets independently', () => {
    const r5 = BASE + 5 * HOUR;
    const rw = BASE + 7 * 24 * HOUR;
    const claude = claudeCred('claude-1.json', 'c-1', 'Max 20x');

    // Antigravity: Gemini spend ($10) + 3P Claude spend ($25) in the same interval.
    insertReq(10, { provider: 'antigravity', authIndex: 'ag-1', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', costUsd: 10 });
    insertReq(20, { provider: 'antigravity', authIndex: 'ag-1', model: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5', costUsd: 25 });
    // Claude: Opus ($14) + Fable ($14) in the same interval; seven_day moves 2% ($1,400/wk), seven_day_fable moves 4% ($350/wk).
    insertReq(15, { provider: 'claude', authIndex: 'c-1', model: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5', costUsd: 14 });
    insertReq(25, { provider: 'claude', authIndex: 'c-1', model: 'claude-fable-5-2', effectiveModel: 'claude-fable-5-2', costUsd: 14 });

    const samples = [
      sample(0, {
        [agCred.id]: { 'ag_summary:gemini-weekly': 10, 'ag_summary:3p-weekly': 10 },
        [claude.id]: { five_hour: 10, seven_day: 10, seven_day_fable: 10 },
      }, {
        [agCred.id]: { 'ag_summary:gemini-weekly': rw, 'ag_summary:3p-weekly': rw },
        [claude.id]: { five_hour: r5, seven_day: rw, seven_day_fable: rw },
      }),
      sample(40, {
        [agCred.id]: { 'ag_summary:gemini-weekly': 12, 'ag_summary:3p-weekly': 20 },
        [claude.id]: { five_hour: 20, seven_day: 12, seven_day_fable: 14 },
      }, {
        [agCred.id]: { 'ag_summary:gemini-weekly': rw, 'ag_summary:3p-weekly': rw },
        [claude.id]: { five_hour: r5, seven_day: rw, seven_day_fable: rw },
      }),
    ];

    const out = estimateQuotaWindows(db, { samples, credentials: [agCred, claude] });
    const agGemini = planReachForCombo(out, 'antigravity', 'gemini-4-neon', new Map([['ag-1', 10]]), null)!;
    const ag3p = planReachForCombo(out, 'antigravity', 'claude-opus-5-5', new Map([['ag-1', 25]]), null)!;
    const claudeOpus = planReachForCombo(out, 'claude', 'claude-opus-5-5', new Map([['c-1', 14]]), null)!;
    const claudeFable = planReachForCombo(out, 'claude', 'claude-fable-5-2', new Map([['c-1', 14]]), null)!;

    expect(agGemini.weekly?.usdPerFull).toBeCloseTo(500);
    expect(ag3p.weekly?.usdPerFull).toBeCloseTo(250);
    // Opus uses general seven_day ($28 / 2% = $1,400/wk); Fable binds to seven_day_fable ($14 / 4% = $350/wk).
    expect(claudeOpus.weekly?.usdPerFull).toBeCloseTo(1400);
    expect(claudeFable.weekly?.usdPerFull).toBeCloseTo(350);
  });

  it('coalesces 1% integer ticks and weights multi-account tiers by combo spend while respecting account scope', () => {
    const rw = BASE + 7 * 24 * HOUR;
    const c20 = claudeCred('claude-20x.json', 'c-20', 'Max 20x');
    const c5 = claudeCred('claude-5x.json', 'c-5', 'Max 5x');

    // Max 20x: two 1% ticks totaling $28 ($1,400/wk).
    insertReq(10, { provider: 'claude', authIndex: 'c-20', model: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5', costUsd: 10 });
    insertReq(20, { provider: 'claude', authIndex: 'c-20', model: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5', costUsd: 18 });
    // Max 5x: one 2% tick totaling $7 ($350/wk).
    insertReq(15, { provider: 'claude', authIndex: 'c-5', model: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5', costUsd: 7 });

    const samples = [
      sample(0, { [c20.id]: { seven_day: 10 }, [c5.id]: { seven_day: 10 } }, { [c20.id]: { seven_day: rw }, [c5.id]: { seven_day: rw } }),
      sample(15, { [c20.id]: { seven_day: 11 }, [c5.id]: { seven_day: 10 } }, { [c20.id]: { seven_day: rw }, [c5.id]: { seven_day: rw } }),
      sample(30, { [c20.id]: { seven_day: 12 }, [c5.id]: { seven_day: 12 } }, { [c20.id]: { seven_day: rw }, [c5.id]: { seven_day: rw } }),
    ];

    const out = estimateQuotaWindows(db, { samples, credentials: [c20, c5] });
    // Two 1% ticks coalesced into 1 interval of 2% ($1,400/wk).
    expect(out.find((s) => s.authIndex === 'c-20')!.estimate.intervals).toBe(1);
    expect(out.find((s) => s.authIndex === 'c-20')!.estimate.usdPerFull).toBeCloseTo(1400);

    // Spend-weighted across both accounts: 80% on 20x ($1400) + 20% on 5x ($350) = $1190/wk.
    const mixed = planReachForCombo(out, 'claude', 'claude-opus-5-5', new Map([['c-20', 28], ['c-5', 7]]), null)!;
    expect(mixed.weekly?.usdPerFull).toBeCloseTo(1190);
    expect(mixed.plans).toEqual(['Max 20x', 'Max 5x']);
    expect(mixed.accounts).toBe(2);

    // Scoped to only the 20x account isolates $1,400/wk.
    const only20 = planReachForCombo(out, 'claude', 'claude-opus-5-5', new Map([['c-20', 28], ['c-5', 7]]), new Set(['c-20']))!;
    expect(only20.weekly?.usdPerFull).toBeCloseTo(1400);
    expect(only20.plans).toEqual(['Max 20x']);
    expect(only20.accounts).toBe(1);
  });

  it('keeps an idle 0% on_use window waking up after more than 2 hours', () => {
    const r5 = BASE + 9 * HOUR;
    insertReq(230, { costUsd: 14 });
    const samples = [
      sample(0, { [agCred.id]: { 'ag_summary:gemini-5h': 0 } }, { [agCred.id]: {} }),
      sample(240, { [agCred.id]: { 'ag_summary:gemini-5h': 10 } }, { [agCred.id]: { 'ag_summary:gemini-5h': r5 } }),
    ];
    const out = estimateQuotaWindows(db, { samples, credentials: [agCred] });
    expect(out).toHaveLength(1);
    expect(out[0]!.estimate.usdPerFull).toBeCloseTo(140);
  });
});
