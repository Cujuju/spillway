import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comboKey, quantile, type CompareReport } from '@shared/activityCompare';
import { tokenCost } from '@shared/modelPrices';
import { FIVE_HOUR_MS, MONTH_FROM_WEEK, WEEK_MS } from '@shared/quotaValue';
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
    expect(r.combos[0]!.planReach).toBeNull();
    expect(log.compare({ scope: { accounts: null, clients: null }, from: now, to: now - 1 })).toBeNull();
  });

  it('attaches implied planReach when quota history is provided', () => {
    const req1 = event(40, { sessionId: 'claude:s1', inputTokens: 1_000_000, outputTokens: 100_000 });
    const req2 = event(20, { sessionId: 'claude:s2', inputTokens: 1_000_000, outputTokens: 100_000 });
    log.append(req1);
    log.append(req2);
    const reqCost = cost(req1) + cost(req2);
    const reset5 = now + FIVE_HOUR_MS;
    const reset7 = now + WEEK_MS;
    const r = log.compare({ scope: { accounts: null, clients: null }, from: now - 2 * HOUR_MS, to: now }, {
      credentials: [{
        id: 'claude-a.json', authIndex: 'a', provider: 'claude', planLabel: 'Max 20x',
        windows: [
          { key: 'five_hour', durationMs: FIVE_HOUR_MS, scoped: false },
          { key: 'seven_day', durationMs: WEEK_MS, scoped: false },
        ],
      }],
      samples: [
        { at: new Date(now - 50 * 60_000).toISOString(), used: { 'claude-a.json': { five_hour: 10, seven_day: 20 } }, resets: { 'claude-a.json': { five_hour: reset5, seven_day: reset7 } } },
        { at: new Date(now - 10 * 60_000).toISOString(), used: { 'claude-a.json': { five_hour: 20, seven_day: 22 } }, resets: { 'claude-a.json': { five_hour: reset5, seven_day: reset7 } } },
      ],
    })!;
    const opus = r.combos.find((c) => c.key === OPUS)!;
    expect(opus.provider).toBe('claude');
    expect(opus.planReach?.fiveHour?.usdPerFull).toBeCloseTo(reqCost * 10);
    expect(opus.planReach?.weekly?.usdPerFull).toBeCloseTo(reqCost * 50);
    expect(opus.planReach?.monthlyUsd).toBeCloseTo(reqCost * 50 * MONTH_FROM_WEEK);
    expect(opus.planReach?.plans).toEqual(['Max 20x']);
  });

  it('computes per-turn step and thinking-step stats including subagents and hasThinking-only models', () => {
    // Turn 1 on Opus: 2 root steps (1 thinking) + 1 Sonnet subagent step (thinking) = 3 steps, 2 thinking steps.
    log.append(event(40, { sessionId: 'claude:r1', sessionKind: 'root', turnKey: 'claude:t1', thinkingTokens: 120 }));
    log.append(event(39, { ...sonnet, sessionId: 'claude:r1:agent:a1', parentSessionId: 'claude:r1', sessionKind: 'subagent', turnKey: 'claude:st1', thinkingTokens: 40 }));
    log.append(event(38, { sessionId: 'claude:r1', sessionKind: 'root', turnKey: 'claude:t1', thinkingTokens: 0 }));
    // Turn 2 on Opus: 1 root step (0 thinking).
    log.append(event(35, { sessionId: 'claude:r1', sessionKind: 'root', turnKey: 'claude:t2', thinkingTokens: 0 }));
    // Turn 1 on Neon (thinkingTokens null, hasThinking set): 2 steps, 1 thinking.
    log.append(event(30, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:n1', sessionKind: 'root', turnKey: 'agy:0', thinkingTokens: null, hasThinking: true }));
    log.append(event(29, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:n1', sessionKind: 'root', turnKey: 'agy:0', thinkingTokens: null, hasThinking: false }));

    const r = report();
    const opus = r.combos.find((c) => c.key === OPUS)!;
    expect(opus.turns).toEqual({ turns: 2, meanSteps: 2, medianSteps: 2, meanThinkingSteps: 1, medianThinkingSteps: 1 });
    const son = r.combos.find((c) => c.key === SONNET)!;
    expect(son.turns).toBeNull();
    const neon = r.combos.find((c) => c.key === comboKey({ model: 'gemini-4-neon', effort: 'high' }))!;
    expect(neon.turns).toEqual({ turns: 1, meanSteps: 2, medianSteps: 2, meanThinkingSteps: 1, medianThinkingSteps: 1 });
  });
});
