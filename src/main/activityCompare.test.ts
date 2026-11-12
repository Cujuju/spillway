import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comboKey, quantile, type CompareReport } from '@shared/activityCompare';
import { tokenCost } from '@shared/modelPrices';
import type { ActivityEvent } from '@shared/types';
import { ActivityLog } from './activityStore';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-compare-'));
let log: ActivityLog;
let sequence = 0;
beforeEach(() => { log = new ActivityLog({ activityDb: path.join(dir, `${sequence++}.db`), legacyActivityDir: path.join(dir, 'absent'), databaseKey: 'ab'.repeat(32), retentionDays: 30 }); });
afterEach(() => log.close());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOUR_MS = 60 * 60 * 1000;
const now = Date.now();
const event = (minutesAgo: number, patch: Partial<ActivityEvent>): ActivityEvent => ({
  at: new Date(now - minutesAgo * 60_000).toISOString(), requestId: `r${sequence++}`, selectionId: null, upstreamId: null, source: 'proxy',
  provider: 'claude', model: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5', reasoningEffort: 'high', authIndex: 'a', stream: true, failed: false,
  statusCode: 200, error: null, latencyMs: 10, ttftMs: 1, inputTokens: 1000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0,
  sessionId: null, movedFrom: null, userAgent: null, client: 'cli', ...patch,
});
const cost = (e: ActivityEvent) => tokenCost(e.provider, e.effectiveModel ?? e.model, e.at, e)!.usd;
const OPUS = comboKey({ model: 'claude-opus-5-5', effort: 'high' });
const SONNET = comboKey({ model: 'claude-sonnet-5-5', effort: 'medium' });
const sonnet = { model: 'claude-sonnet-5-5', effectiveModel: 'claude-sonnet-5-5', reasoningEffort: 'medium' };
const report = (): CompareReport => log.compare({ scope: { accounts: null, clients: null }, from: now - 2 * HOUR_MS, to: now })!;

describe('compareActivity', () => {
  it('interpolates percentiles between closest ranks', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7);
    expect(quantile([5], 0.9)).toBe(5);
  });

  it('counts subagents toward their root task and reconciles each combination\'s spend', () => {
    const root = [event(30, { sessionId: 'claude:s1', thinkingTokens: 100 }), event(20, { sessionId: 'claude:s1', failed: true })];
    const sub = event(25, { ...sonnet, sessionId: 'claude:s1:agent:x', parentSessionId: 'claude:s1', sessionKind: 'subagent', tier: 'fast' });
    const other = event(10, { ...sonnet, sessionId: 'claude:s2' });
    const unknown = event(5, { reasoningEffort: null, sessionId: 'claude:s3' });
    for (const e of [...root, sub, other, unknown]) log.append(e);
    const r = report();
    const opus = r.combos.find((c) => c.key === OPUS)!;
    const son = r.combos.find((c) => c.key === SONNET)!;
    expect(opus.tasks).toMatchObject({ tasks: 1, mixed: 1, medianRequests: 3 });
    expect(opus.tasks!.otherCostUsd).toBeCloseTo(cost(sub));
    expect(opus.tasks!.costUsd).toBeCloseTo(cost(root[0]!) + cost(root[1]!) + cost(sub));
    expect(opus.asSubagentCostUsd).toBe(0);
    expect(son.tasks).toMatchObject({ tasks: 1, mixed: 0 });
    expect(son.asSubagentCostUsd).toBeCloseTo(cost(sub));
    // Started here, less other combinations inside, plus subagent work elsewhere, is what was spent here.
    for (const c of [opus, son]) expect(c.tasks!.costUsd - c.tasks!.otherCostUsd + c.asSubagentCostUsd).toBeCloseTo(c.whole.costUsd);
    expect(opus.whole).toMatchObject({ requests: 2, failed: 1, thinkingTokens: 100, detailRequests: 2 });
    expect(son.whole.fastRequests).toBe(1);
    expect(r.unknownEffort).toMatchObject({ requests: 1, models: [{ model: 'claude-opus-5-5', requests: 1 }] });
    expect(r.unknownEffort.costUsd).toBeCloseTo(cost(unknown));
    expect(r.retained?.days).toBeGreaterThanOrEqual(1);
    expect(r.shares?.from).toBe(r.retained?.from);
  });

  it('starts a task on its root session\'s first combination even when a subagent spoke first', () => {
    log.append(event(30, { ...sonnet, sessionId: 'claude:s1:agent:x', parentSessionId: 'claude:s1' }));
    log.append(event(20, { sessionId: 'claude:s1' }));
    const r = report();
    expect(r.combos.find((c) => c.key === OPUS)!.tasks?.tasks).toBe(1);
    expect(r.combos.find((c) => c.key === SONNET)!.tasks).toBeNull();
  });

  it('honours the scope and rejects malformed queries', () => {
    log.append(event(10, { authIndex: 'a' }));
    log.append(event(10, { authIndex: 'b', sessionId: 'claude:b' }));
    const r = log.compare({ scope: { accounts: ['b'], clients: null }, from: now - 2 * HOUR_MS, to: now })!;
    expect(r.combos[0]!.whole.requests).toBe(1);
    expect(r.combos[0]!.tasks?.tasks).toBe(1);
    expect(log.compare({ scope: { accounts: null, clients: null }, from: now, to: now - 1 })).toBeNull();
  });
});
