import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EVERY_REQUEST } from '@shared/activityScope';
import { localDay } from '@shared/activityCounts';
import type { ActivityEvent } from '@shared/types';
import { openActivityDb } from './activityDb';
import { ActivityLog } from './activityStore';
import { wasteActivity } from './activityWaste';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const dirs: string[] = [];

function createLog(): ActivityLog {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-waste-'));
  dirs.push(dir);
  return new ActivityLog({
    activityDb: path.join(dir, 'activity.db'),
    legacyActivityDir: path.join(dir, 'legacy'),
    databaseKey: TEST_KEY,
    retentionDays: 3650,
  });
}

let reqSeq = 0;
function event(patch: Partial<ActivityEvent>): ActivityEvent {
  reqSeq += 1;
  return {
    at: '2026-11-24T12:00:00.000Z',
    requestId: `req-${reqSeq}`,
    selectionId: null,
    upstreamId: null,
    source: 'proxy',
    provider: 'antigravity',
    model: 'gemini-4-neon',
    authIndex: 'acct-1',
    stream: true,
    failed: false,
    statusCode: 200,
    error: null,
    latencyMs: 500,
    ttftMs: 100,
    inputTokens: 50_000,
    outputTokens: 1_000,
    cachedTokens: 45_000,
    cacheWriteTokens: 0,
    sessionId: 'sess-1',
    movedFrom: null,
    userAgent: 't3',
    client: 't3',
    reasoningEffort: 'high',
    ...patch,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('wasteActivity', () => {
  it('computes exact cost anatomy, prompt buckets, cold misses, switches, and top sessions', () => {
    const log = createLog();
    const baseMs = Date.parse('2026-10-15T10:00:00.000Z');
    const at = (min: number) => new Date(baseMs + min * 60_000).toISOString();

    // Small warm request (<100K)
    log.append(event({ at: at(0), sessionId: 'sess-neon', inputTokens: 60_000, cachedTokens: 55_000, outputTokens: 1_000 }));
    // Mid-turn cold miss on >350K prompt (2 min after previous, cache hit 10%)
    log.append(event({ at: at(2), sessionId: 'sess-neon', inputTokens: 400_000, cachedTokens: 40_000, outputTokens: 2_000 }));
    // Idle wake cold miss (12 min gap, effort switched high -> medium, 250K prompt)
    log.append(event({ at: at(14), sessionId: 'sess-neon', inputTokens: 250_000, cachedTokens: 25_000, outputTokens: 1_500, reasoningEffort: 'medium' }));
    // Claude request with cache writes and model switch
    log.append(event({
      at: at(16), sessionId: 'sess-claude', provider: 'claude', model: 'claude-opus-5-5',
      inputTokens: 10_000, cachedTokens: 140_000, cacheWriteTokens: 10_000, outputTokens: 2_000,
    }));
    // Claude idle wake cold miss (10 min gap, 180K cache write -> <70% hit)
    log.append(event({
      at: at(26), sessionId: 'sess-claude', provider: 'claude', model: 'claude-sonnet-5-5',
      inputTokens: 2_000, cachedTokens: 20_000, cacheWriteTokens: 180_000, outputTokens: 1_000,
    }));

    const report = log.waste({ scope: EVERY_REQUEST, from: baseMs - 60_000, to: baseMs + 60 * 60_000 })!;
    expect(report).not.toBeNull();
    expect(report.requests).toBe(5);
    expect(report.pricedRequests).toBe(5);
    expect(report.unpricedRequests).toBe(0);

    // Anatomy sum matches totalCostUsd
    const anatomySum = report.anatomy.uncachedInputUsd + report.anatomy.cacheWriteUsd + report.anatomy.cacheReadUsd + report.anatomy.outputUsd;
    expect(anatomySum).toBeCloseTo(report.totalCostUsd, 8);
    expect(report.anatomy.cacheWriteUsd).toBeGreaterThan(0);

    // Bucket sums match totalCostUsd and >200K share includes 200K-350K + >350K
    const bucketSum = report.promptBuckets.reduce((s, b) => s + b.costUsd, 0);
    expect(bucketSum).toBeCloseTo(report.totalCostUsd, 8);
    const over350 = report.promptBuckets.find((b) => b.id === 'over350k')!;
    const mid200 = report.promptBuckets.find((b) => b.id === '200kTo350k')!;
    expect(over350.requests).toBe(1);
    expect(mid200.requests).toBe(2);
    expect(report.over200kCostUsd).toBeCloseTo(over350.costUsd + mid200.costUsd, 8);

    // Cold misses split cleanly between idle wakeups and mid-turn invalidations
    expect(report.coldMisses.total.requests).toBe(3);
    expect(report.coldMisses.afterIdle.requests).toBe(2);
    expect(report.coldMisses.midTurn.requests).toBe(1);
    expect(report.coldMisses.unclassified.requests).toBe(0);
    expect(report.coldMisses.effortSwitches).toBe(1);
    expect(report.coldMisses.modelSwitches).toBe(1);

    // Top sessions ranked by spend with driver tags
    expect(report.topSessions.length).toBe(2);
    expect(report.topSessions[0]!.sessionId).toBe('sess-neon');
    expect(report.topSessions[0]!.drivers).toEqual(expect.arrayContaining(['over350k', 'idleWakes', 'midTurnMisses', 'effortSwitch', 'lowCache']));
    expect(report.topSessions[1]!.sessionId).toBe('sess-claude');
    expect(report.topSessions[1]!.drivers).toContain('modelSwitch');
    log.close();
  });

  it('classifies cold misses and switches using prior retained session history across scope and range cuts', () => {
    const log = createLog();
    const baseMs = Date.parse('2026-10-15T10:00:00.000Z');
    const at = (min: number) => new Date(baseMs + min * 60_000).toISOString();

    // Prior request sits before range.from and at a different effort
    log.append(event({ at: at(0), sessionId: 'sess-cut', reasoningEffort: 'medium', inputTokens: 100_000, cachedTokens: 90_000 }));
    // Destination request 9 minutes later at high effort -> both idle wake and effort switch
    log.append(event({ at: at(9), sessionId: 'sess-cut', reasoningEffort: 'high', inputTokens: 160_000, cachedTokens: 20_000 }));

    const report = log.waste({ scope: { ...EVERY_REQUEST, efforts: ['high'] }, from: baseMs + 5 * 60_000, to: baseMs + 30 * 60_000 })!;
    expect(report.requests).toBe(1);
    expect(report.coldMisses.total.requests).toBe(1);
    expect(report.coldMisses.afterIdle.requests).toBe(1);
    expect(report.coldMisses.unclassified.requests).toBe(0);
    expect(report.coldMisses.effortSwitches).toBe(1);
    expect(report.topSessions[0]!.idleWakes).toBe(1);
    expect(report.topSessions[0]!.effortSwitches).toBe(1);
    expect(report.topSessions[0]!.drivers).toEqual(expect.arrayContaining(['idleWakes', 'effortSwitch']));
    log.close();
  });

  it('counts cold misses without session history as unclassified and ranks session model/effort pairs without synthetic weights', () => {
    const log = createLog();
    const baseMs = Date.parse('2026-10-15T10:00:00.000Z');
    const at = (min: number) => new Date(baseMs + min * 60_000).toISOString();

    // Qualifying cold miss with no session ID
    log.append(event({ at: at(0), sessionId: null, inputTokens: 150_000, cachedTokens: 10_000 }));
    // First retained request in a session is a cold miss (no predecessor)
    log.append(event({ at: at(1), sessionId: 'sess-first', inputTokens: 150_000, cachedTokens: 10_000 }));

    // Session with 2 unpriced $0 requests (effort: 'high') and 1 priced request (effort: null, <$1)
    log.append(event({ at: at(2), sessionId: 'sess-mix', model: 'unpriced-model', reasoningEffort: 'high', inputTokens: 10_000, cachedTokens: 0 }));
    log.append(event({ at: at(3), sessionId: 'sess-mix', model: 'unpriced-model', reasoningEffort: 'high', inputTokens: 10_000, cachedTokens: 0 }));
    log.append(event({ at: at(4), sessionId: 'sess-mix', model: 'gemini-4-neon', reasoningEffort: undefined, inputTokens: 50_000, cachedTokens: 0, outputTokens: 0 }));

    const report = log.waste({ scope: EVERY_REQUEST, from: baseMs - 60_000, to: baseMs + 60 * 60_000 })!;
    expect(report.coldMisses.total.requests).toBe(2);
    expect(report.coldMisses.unclassified.requests).toBe(2);
    expect(report.coldMisses.afterIdle.requests).toBe(0);
    expect(report.coldMisses.midTurn.requests).toBe(0);

    const firstSess = report.topSessions.find((s) => s.sessionId === 'sess-first')!;
    expect(firstSess.coldMissUsd).toBeGreaterThan(0);

    const mixSess = report.topSessions.find((s) => s.sessionId === 'sess-mix')!;
    expect(mixSess.model).toBe('gemini-4-neon');
    expect(mixSess.effort).toBeNull();
    log.close();
  });

  it('applies strict prompt-size and cold-miss cutoffs while keeping buckets contiguous', () => {
    const log = createLog();
    const baseMs = Date.parse('2026-10-15T10:00:00.000Z');
    const at = (min: number) => new Date(baseMs + min * 60_000).toISOString();

    // Exactly 200K stays in 100K-200K; 200,001 enters >200K
    log.append(event({ at: at(0), sessionId: 'sess-edge', inputTokens: 200_000, cachedTokens: 190_000 }));
    log.append(event({ at: at(1), sessionId: 'sess-edge', inputTokens: 200_001, cachedTokens: 190_000 }));
    // Exactly 80K prompt / 50K cold does not trigger strict > cutoffs
    log.append(event({ at: at(10), sessionId: 'sess-edge', inputTokens: 80_000, cachedTokens: 30_000 }));

    const report = log.waste({ scope: EVERY_REQUEST, from: baseMs - 60_000, to: baseMs + 60 * 60_000 })!;
    expect(report.promptBuckets.find((b) => b.id === '100kTo200k')!.requests).toBe(1);
    expect(report.promptBuckets.find((b) => b.id === '200kTo350k')!.requests).toBe(1);
    expect(report.coldMisses.total.requests).toBe(0);
    log.close();
  });

  it('resolves All (from: null) from the oldest retained request in SQLite beyond the 31-day bucket window', () => {
    const log = createLog();
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const oldAt = new Date(nowMs - 34 * dayMs).toISOString();
    const recentAt = new Date(nowMs - dayMs).toISOString();
    log.append(event({ at: oldAt, sessionId: 'sess-old', inputTokens: 120_000, cachedTokens: 100_000 }));
    log.append(event({ at: recentAt, sessionId: 'sess-new', inputTokens: 120_000, cachedTokens: 100_000 }));

    const report = log.waste({ scope: EVERY_REQUEST, from: null, to: nowMs })!;
    expect(report.requests).toBe(2);
    expect(report.retained).not.toBeNull();
    expect(report.range.from).toBe(report.retained!.from);
    expect(report.range.days).toBeGreaterThanOrEqual(34);
    log.close();
  });

  it('uses indexed day bounds covering UTC-12 to UTC+14 timezone shifts for All and bounded ranges', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spillway-waste-tz-'));
    dirs.push(dir);
    const db = openActivityDb(path.join(dir, 'activity.db'), TEST_KEY);
    // 10:30 UTC falls on the next calendar day in UTC+14 (Kiritimati) and the prior day in UTC-11 (Pago Pago).
    const atMs = Date.parse('2026-11-24T10:30:00.000Z');
    const toMs = Date.parse('2026-11-24T10:45:00.000Z');
    const eastEvent = event({ at: new Date(atMs).toISOString(), sessionId: 'sess-tz-east', inputTokens: 120_000, cachedTokens: 100_000 });
    const westEvent = event({ at: new Date(atMs + 1000).toISOString(), sessionId: 'sess-tz-west', inputTokens: 120_000, cachedTokens: 100_000 });
    db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)').run('2026-11-25', 0, JSON.stringify(eastEvent));
    db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)').run('2026-11-23', 0, JSON.stringify(westEvent));

    // Verify bounded query uses an index on requests rather than a full table scan.
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id, event FROM requests WHERE day BETWEEN ? AND ?').all('2026-11-23', '2026-11-25') as { detail: string }[];
    expect(plan.some((p) => /SEARCH requests USING INDEX requests_(?:by_day|day_summary)/.test(p.detail))).toBe(true);

    const allReport = wasteActivity(db, { scope: EVERY_REQUEST, from: null, to: toMs }, toMs)!;
    expect(allReport.requests).toBe(2);
    expect(allReport.range.from).toBe(localDay(atMs));
    expect(allReport.retained?.from).toBe(localDay(atMs));

    const bounded = wasteActivity(db, { scope: EVERY_REQUEST, from: atMs - 60_000, to: toMs }, toMs)!;
    expect(bounded.requests).toBe(2);
    expect(bounded.retained?.from).toBe(localDay(atMs));
    db.close();
  });

  it('respects scope filters and rejects malformed queries', () => {
    const log = createLog();
    const baseMs = Date.parse('2026-10-15T10:00:00.000Z');
    log.append(event({ at: new Date(baseMs).toISOString(), authIndex: 'acct-a', inputTokens: 120_000, cachedTokens: 100_000 }));
    log.append(event({ at: new Date(baseMs + 60_000).toISOString(), authIndex: 'acct-b', inputTokens: 120_000, cachedTokens: 100_000 }));

    const scoped = log.waste({ scope: { ...EVERY_REQUEST, accounts: ['acct-a'] }, from: baseMs - 1000, to: baseMs + 120_000 })!;
    expect(scoped.requests).toBe(1);
    expect(log.waste({ scope: EVERY_REQUEST, from: baseMs + 1000, to: baseMs })).toBeNull();
    expect(log.waste(undefined as never)).toBeNull();
    log.close();
  });
});
