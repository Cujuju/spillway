import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import type { ThinkingReport } from '@shared/thinking';
import { tokenCost } from '@shared/modelPrices';
import type { ActivityEvent } from '@shared/types';
import { kind } from './activityThinking';
import { group } from './retainedTurns';
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
const report = (): ThinkingReport => log.thinking({ scope: { accounts: null, clients: null }, from: now - 2 * HOUR_MS, to: now }, [])!;
const append = (minutes: number, patch: Partial<ActivityEvent> = {}) => log.append(event(minutes, { sessionId: 'root', turnKey: 'one', thinkingTokens: 100, ...patch }));

it('groups consecutive keys, attaches nested subagents at their first request, and excludes missing identities', () => {
  append(60); append(59);
  append(58, { sessionId: 'child', parentSessionId: 'root', sessionKind: 'subagent', turnKey: 'child' });
  append(57, { turnKey: 'two' });
  append(56, { sessionId: 'grandchild', parentSessionId: 'child', sessionKind: 'subagent', turnKey: 'grandchild' });
  append(55, { sessionId: 'child', parentSessionId: 'root', sessionKind: 'subagent', turnKey: 'child' });
  append(54, { turnKey: null }); append(53, { turnKey: 'two' });
  append(52, { sessionId: 'orphan', parentSessionId: 'absent', sessionKind: 'subagent' });
  append(51, { reasoningEffort: null });
  const r = report(), s = r.settings[0]!;
  expect(s.turns).toBe(3);
  expect(s.kinds.map((k) => k.turns)).toEqual([1, 0, 2]);
  expect(r.untracked.requests).toBe(3);
  expect(s.costUsd).toBeCloseTo(cost(event(60, {})) * 7);
});

it('classifies request and thinking boundaries including failures', () => {
  for (const [index, size] of [2, 3, 15, 16].entries()) {
    for (let n = 0; n < size; n++) append(70 - index * 10 - n / 10, { turnKey: `t${index}`, thinkingTokens: n === 0 ? [2000, 2001, 20000, 20001][index] : 0, outputTokens: 30000, failed: n === 1 });
  }
  const s = report().settings[0]!;
  expect(s.kinds.map((k) => k.turns)).toEqual([1, 2, 1]);
  expect(s.buckets.map((b) => b.turns)).toEqual([1, 2, 1]);
});

it('estimates own effort ratios, falls back across kinds, and builds mixed estimates', () => {
  for (let n = 0; n < 10; n++) {
    append(100 - n, { sessionId: `high${n}`, thinkingTokens: 200, turnKey: 'h' });
    append(70 - n, { sessionId: `medium${n}`, reasoningEffort: 'medium', thinkingTokens: 100, turnKey: 'm' });
  }
  for (let n = 0; n < 3; n++) append(40 - n, { sessionId: 'change', turnKey: 'c', thinkingTokens: 200 });
  append(20, { sessionId: 'long', turnKey: 'l', thinkingTokens: 200 });
  append(19, { sessionId: 'agent', parentSessionId: 'long', sessionKind: 'subagent', turnKey: 'a', thinkingTokens: 200 });
  const s = report().settings.find((s) => s.setting.effort === 'high')!;
  const medium = s.alternatives.find((a) => a.method === 'effort-ratio' && a.setting.effort === 'medium')!;
  expect(medium.reason).toBeNull();
  expect(medium.savingUsdPerWeek).toBeGreaterThan(0);
  expect(s.alternatives.some((a) => a.setting.effort === 'low')).toBe(false);
  const mixed = s.alternatives.find((a) => a.method === 'mixed')!;
  expect(mixed).toMatchObject({ setting: { effort: 'medium' }, reason: null });
  expect(mixed.costUsdPerWeek).toBeGreaterThan(medium.costUsdPerWeek!);
});

it('prunes older dominated candidates and reprices tokens once', () => {
  append(60, { outputTokens: 2000, thinkingTokens: 1000, tier: 'fast' });
  const r = log.thinking({ scope: { accounts: null, clients: null }, from: now - HOUR_MS * 2, to: now }, [
    { id: 'claude-sonnet-4-6', provider: 'claude', created: 1 },
    { id: 'claude-sonnet-5-5', provider: 'claude', created: 2 },
    { id: 'claude-haiku-5-5', provider: 'claude', created: 3 },
    { id: 'gpt-6-luna', provider: 'codex', created: 4 },
    { id: 'unknown', provider: 'claude', created: 4 },
  ])!;
  const s = r.settings[0]!, models = s.alternatives.filter((a) => a.method === 'reprice');
  expect(models.map((a) => a.setting.model)).toEqual(['claude-haiku-5-5']);
  expect(models[0]!.costUsdPerWeek).toBeCloseTo(tokenCost('claude', 'claude-haiku-5-5', now, event(60, { outputTokens: 2000, thinkingTokens: 1000, tier: 'fast' }))!.usd * 7);
  expect(s.thinkingCostUsd).toBeCloseTo(0.04);
});

it('counts only starts inside the range and honours scope', () => {
  append(150); append(60);
  append(50, { turnKey: 'new', authIndex: 'other' });
  expect(report().settings[0]!.turns).toBe(1);
  expect(log.thinking({ scope: { accounts: ['a'], clients: null }, from: now - 2 * HOUR_MS, to: now }, [])!.settings).toEqual([]);
  expect(log.thinking({ from: NaN, to: now } as never, [])).toBeNull();
});

it('keeps undated candidates and preserves stored failed-request costs', () => {
  log.append({ ...event(60, { sessionId: 'root', turnKey: 'paid', failed: true, thinkingTokens: 100 }), costUsd: 2, uncachedCostUsd: 2 });
  const r = log.thinking({ scope: { accounts: null, clients: null }, from: now - 2 * HOUR_MS, to: now }, [
    { id: 'claude-sonnet-5-5', provider: 'claude' },
    { id: 'claude-haiku-5-5', provider: 'claude', created: 3 },
  ])!;
  expect(r.settings[0]!.costUsd).toBe(2);
  expect(r.settings[0]!.alternatives.filter((a) => a.method === 'reprice').map((a) => a.setting.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
});

it('does not estimate without measured thinking and caps closest model choices', () => {
  for (let n = 0; n < 10; n++) {
    append(100 - n, { sessionId: `high${n}`, turnKey: 'h', thinkingTokens: null });
    append(70 - n, { sessionId: `medium${n}`, turnKey: 'm', reasoningEffort: 'medium', thinkingTokens: 100 });
  }
  const r = log.thinking({ scope: { accounts: null, clients: null }, from: now - 2 * HOUR_MS, to: now },
    ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => ({ id, provider: 'claude', created: 1 })))!;
  const s = r.settings.find((s) => s.setting.effort === 'high')!;
  expect(s.alternatives.find((a) => a.setting.effort === 'medium')).toMatchObject({ reason: 'not-enough-data', medianTurnCostUsd: null });
  expect(s.alternatives.some((a) => a.method === 'mixed')).toBe(false);
  expect(s.kinds[0]!.lowerEffortSavingUsdPerWeek).toBeNull();
  expect(s.alternatives.filter((a) => a.method === 'reprice').map((a) => a.setting.model)).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4']);
});


it('orders all observed provider efforts below ultra and adds unobserved medium', () => {
  const efforts = ['ultra', 'max', 'xhigh', 'high', 'low', 'minimal', 'none'];
  for (const [index, effort] of efforts.entries()) append(90 - index, {
    sessionId: `codex${effort}`, provider: 'codex', model: 'gpt-6.1-sol', effectiveModel: 'gpt-6.1-sol', reasoningEffort: effort,
  });
  append(60);
  append(59, { sessionId: 'sonnet', model: 'claude-sonnet-5-5', effectiveModel: 'claude-sonnet-5-5', reasoningEffort: 'low' });
  const r = report();
  const ultra = r.settings.find((s) => s.setting.effort === 'ultra')!;
  expect(ultra.alternatives.filter((a) => a.method === 'effort-ratio').map((a) => a.setting.effort))
    .toEqual(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
  const claude = r.settings.find((s) => s.setting.provider === 'claude' && s.setting.effort === 'high')!;
  expect(claude.alternatives.map((a) => a.setting.effort)).toEqual(['medium', 'low']);
  expect(claude.alternatives[0]).toMatchObject({ reason: 'not-enough-data' });
  expect(r.settings.find((s) => s.setting.effort === 'none')!.alternatives).toEqual([]);
});

it('keeps compaction continuations and parent chains in one turn, while forks remain roots', () => {
  const requests = [
    event(60, { sessionId: 'root', sessionKind: 'root', turnKey: 'one' }),
    event(59, { sessionId: 'compact', sessionKind: 'compaction', parentSessionId: 'root', turnKey: 'compact' }),
    event(58, { sessionId: 'compact', sessionKind: 'compaction', parentSessionId: 'root', turnKey: 'continuation' }),
    event(57, { sessionId: 'nested', sessionKind: 'compaction', parentSessionId: 'compact', turnKey: 'nested' }),
    event(56, { sessionId: 'fork', sessionKind: 'fork', parentSessionId: 'root', turnKey: 'fork' }),
  ];
  const grouped = group(requests);
  expect(grouped.excluded).toEqual([]);
  expect(grouped.turns).toHaveLength(2);
  expect(grouped.turns[0]!.requests).toHaveLength(4);
  expect(kind(grouped.turns[0]!)).toBe('question');
  expect(grouped.turns[1]!.first.sessionId).toBe('fork');
});

it('tracks per-turn steps and thinking steps for models without thinking_tokens (Neon) and rolls up subagents', () => {
  // Turn 1: 3 steps (2 with thinking) + 1 subagent step (with thinking) = 4 steps, 3 thinking steps.
  log.append(event(60, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:root', sessionKind: 'root', turnKey: 'agy:0', thinkingTokens: null, hasThinking: true }));
  log.append(event(59, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:root', sessionKind: 'root', turnKey: 'agy:0', thinkingTokens: null, hasThinking: false }));
  log.append(event(58, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:sub', parentSessionId: 'agy:root', sessionKind: 'subagent', turnKey: 'agy:0', thinkingTokens: null, hasThinking: true }));
  log.append(event(57, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:root', sessionKind: 'root', turnKey: 'agy:0', thinkingTokens: null, hasThinking: true }));
  // Turn 2: 2 steps (1 with thinking).
  log.append(event(50, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:root', sessionKind: 'root', turnKey: 'agy:10', thinkingTokens: null, hasThinking: true }));
  log.append(event(49, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:root', sessionKind: 'root', turnKey: 'agy:10', thinkingTokens: null, hasThinking: false }));
  const r = report();
  const neon = r.settings.find((s) => s.setting.model === 'gemini-4-neon')!;
  expect(neon).toMatchObject({
    turns: 2, measuredTurns: 0,
    meanStepsPerTurn: 3, medianStepsPerTurn: 3,
    meanThinkingStepsPerTurn: 2, medianThinkingStepsPerTurn: 2,
  });
  expect(neon.kinds.find((k) => k.kind === 'question')).toMatchObject({ turns: 1, meanStepsPerTurn: 2, meanThinkingStepsPerTurn: 1 });
  expect(neon.kinds.find((k) => k.kind === 'long')).toMatchObject({ turns: 1, meanStepsPerTurn: 4, meanThinkingStepsPerTurn: 3 });
});

it('backfills turnKey, hasThinking, and parentSessionId on re-import without duplicating rows or totals', () => {
  const base = event(30, {
    source: 'client-log', requestId: 'client-log:antigravity:abc', provider: 'antigravity',
    model: 'gemini-4-neon', effectiveModel: null, reasoningEffort: 'high',
    sessionId: 'agy:child', parentSessionId: null, sessionKind: null, turnKey: null, thinkingTokens: null,
  });
  log.importEvents([base]);
  const totalsBefore = log.totalsList();
  log.importEvents([{ ...base, turnKey: 'agy:0', hasThinking: true, parentSessionId: 'agy:parent', sessionKind: 'subagent' }]);
  const rows = log.page({ day: null, failedOnly: false, scope: { accounts: null, clients: null, source: 'all' }, before: null }).events;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ turnKey: 'agy:0', hasThinking: true, parentSessionId: 'agy:parent', sessionKind: 'subagent' });
  expect(log.totalsList()).toEqual(totalsBefore);
});

it('counts attached subagents and mid-turn missing-effort steps identically in Thinking and Compare, honors explicit hasThinking over 0 tokens, preserves hasThinking across streaming replacements, and upgrades parser-produced root rows on cached parent append', () => {
  log.relinkParents(new Map([['agy:late-sub', 'agy:root-2']]));
  log.append(event(40, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', sessionId: 'agy:root-2', sessionKind: 'root', turnKey: 'agy:0', thinkingTokens: 0, hasThinking: true }));
  // Mid-turn root step lacking reasoningEffort stays counted in both Thinking and Compare.
  log.append(event(39.5, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: null, sessionId: 'agy:root-2', sessionKind: 'root', turnKey: 'agy:0', thinkingTokens: null, hasThinking: true }));
  // Parser-produced child row (sessionKind: 'root', parentSessionId: null) appended after relinkParents gets upgraded to 'subagent'.
  log.append(event(39, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: null, sessionId: 'agy:late-sub', parentSessionId: null, sessionKind: 'root', turnKey: null, thinkingTokens: null, hasThinking: true }));
  const think = report().settings.find((s) => s.setting.model === 'gemini-4-neon')!;
  const cmp = log.compare({ scope: { accounts: null, clients: null }, from: now - 2 * HOUR_MS, to: now })!.combos.find((c) => c.model === 'gemini-4-neon')!;
  expect(think).toMatchObject({ turns: 1, meanStepsPerTurn: 3, meanThinkingStepsPerTurn: 3 });
  expect(cmp.turns).toEqual({ turns: 1, meanSteps: 3, medianSteps: 3, meanThinkingSteps: 3, medianThinkingSteps: 3 });

  // Account filter excluding the root excludes the turn in both Thinking and Compare even if a linked subagent matches the account.
  log.append(event(35, { provider: 'antigravity', model: 'gemini-4-neon', effectiveModel: 'gemini-4-neon', reasoningEffort: 'high', authIndex: 'acct-other', sessionId: 'agy:sub-only', parentSessionId: 'agy:root-2', sessionKind: 'subagent', turnKey: 'agy:0', thinkingTokens: null, hasThinking: true }));
  const scopedScope = { accounts: ['acct-other'], clients: null };
  const scopedThink = log.thinking({ scope: scopedScope, from: now - 2 * HOUR_MS, to: now }, [])!;
  const scopedCmp = log.compare({ scope: scopedScope, from: now - 2 * HOUR_MS, to: now })!;
  expect(scopedThink.settings).toEqual([]);
  expect(scopedThink.untracked.requests).toBe(1);
  expect(scopedCmp.combos.every((c) => c.turns === null)).toBe(true);

  // Streaming block replacement preserves hasThinking: true when a later higher-output chunk lacks it.
  const streamBase = event(20, { source: 'client-log', requestId: 'client-log:claude:stream1', upstreamId: 'msg_s1', sessionId: 'claude:s', turnKey: 'claude:p1', outputTokens: 10, thinkingTokens: null, hasThinking: true });
  log.importEvents([streamBase]);
  log.importEvents([{ ...streamBase, outputTokens: 40, hasThinking: null }]);
  const stored = log.page({ day: null, failedOnly: false, scope: { accounts: null, clients: null, source: 'all' }, before: null }).events.find((e) => e.requestId === 'client-log:claude:stream1');
  expect(stored).toMatchObject({ outputTokens: 40, hasThinking: true });
});
