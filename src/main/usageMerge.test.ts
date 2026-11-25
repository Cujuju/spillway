import { describe, expect, it } from 'vitest';
import { mergeUsage, sameUsage, USAGE_MATCH_TOLERANCE_MS } from './usageMerge';
import { parseClientLine, splitAntigravityModelEffort } from './clientLogParser';
import { tokenCost } from '@shared/modelPrices';
import type { ActivityEvent } from '@shared/types';

export const sampleUsage = (patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at: '2026-10-29T12:00:00Z', requestId: 'p', upstreamId: null, source: 'proxy', selectionId: null,
  provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a', stream: true, failed: false,
  statusCode: null, error: null, latencyMs: 0, ttftMs: null, inputTokens: 100, outputTokens: 30,
  cachedTokens: 20, cacheWriteTokens: 10, sessionId: 'claude:s', movedFrom: null, userAgent: null, client: 'claude-cli', ...patch,
});

describe('usage merge contract', () => {
  it('uses provider response IDs even across timestamps and sessions', () => {
    expect(sameUsage(sampleUsage({ upstreamId: 'msg_a' }), sampleUsage({ upstreamId: 'msg_a', at: '2025-01-01', sessionId: null }))).toBe(true);
    expect(sameUsage(sampleUsage({ upstreamId: 'msg_a' }), sampleUsage({ upstreamId: 'msg_b' }))).toBe(false);
  });
  it('requires a known normalized session, provider, every token count and the bounded time window', () => {
    const a = sampleUsage();
    expect(sameUsage(a, sampleUsage({ sessionId: 'claude:s:agent:review', at: new Date(Date.parse(a.at) + USAGE_MATCH_TOLERANCE_MS).toISOString() }))).toBe(true);
    for (const patch of [{ inputTokens: 101 }, { outputTokens: 31 }, { cachedTokens: 21 }, { cacheWriteTokens: 11 }, { sessionId: null }, { provider: 'codex' },
      { at: new Date(Date.parse(a.at) + USAGE_MATCH_TOLERANCE_MS + 1).toISOString() }]) expect(sameUsage(a, sampleUsage(patch))).toBe(false);
  });
  it('keeps the proxy, deduplicates reimports, and matches one-to-one', () => {
    const p = sampleUsage();
    const a = sampleUsage({ source: 'client-log', requestId: 'a', authIndex: null });
    const b = { ...a, requestId: 'b' };
    expect(mergeUsage([p], [a, a, b])).toEqual([p, b]);
  });
});

describe('client log formats', () => {
  it('maps Claude separate cache counts and stable content-block identities, skipping synthetic messages', () => {
    const r = { type: 'assistant', sessionId: 's', requestId: 'req', timestamp: '2026-10-29T12:00:00Z', message: {
      id: 'msg_a', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
    } };
    const e = parseClientLine(JSON.stringify(r), 'claude', {});
    expect(e).toMatchObject({ source: 'client-log', upstreamId: 'msg_a', sessionId: 'claude:s', inputTokens: 100, cachedTokens: 20, cacheWriteTokens: 10 });
    expect(parseClientLine(JSON.stringify(r), 'claude', {})?.requestId).toBe(e?.requestId);
    expect(parseClientLine(JSON.stringify({ ...r, message: { ...r.message, model: '<synthetic>' } }), 'claude', {})).toBeNull();
  });
  it('maps Codex inclusive input/output, without adding reasoning again, suppressing repeated totals', () => {
    const context = {};
    const parse = (r: object) => parseClientLine(JSON.stringify(r), 'codex', context);
    parse({ type: 'session_meta', payload: { id: 's', originator: 'codex_cli_rs' } });
    parse({ type: 'turn_context', payload: { model: 'gpt-6', turn_id: 't' } });
    const r = { timestamp: '2026-10-29T12:00:00Z', type: 'event_msg', payload: { type: 'token_count', response_id: 'resp_a', info: {
      total_token_usage: { total_tokens: 130 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 },
    } } };
    expect(parse(r)).toMatchObject({ sessionId: 'codex:s', upstreamId: 'resp_a', inputTokens: 100, cachedTokens: 20, outputTokens: 30 });
    expect(parse(r)).toBeNull();
    expect(parseClientLine('{', 'claude', {})).toBeNull();
  });
});


it('keeps Codex response IDs from token_usage_record without counting its token_count snapshot twice', () => {
  const context = { session: 's', turn: 't', model: 'gpt-6' };
  const usage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 };
  const record = { timestamp: '2026-10-29', type: 'token_usage_record', payload: {
    session_id: 's', turn_id: 't', response_id: 'resp_record', usage, thread_token_usage: usage,
  } };
  const snapshot = { timestamp: '2026-10-29', type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { ...usage, input_tokens: 999 }, last_token_usage: usage },
  } };
  expect(parseClientLine(JSON.stringify(record), 'codex', context)).toMatchObject({ upstreamId: 'resp_record', inputTokens: 100 });
  expect(parseClientLine(JSON.stringify(snapshot), 'codex', context)).toBeNull();
  const reversed = { session: 's', turn: 't', model: 'gpt-6' };
  const first = parseClientLine(JSON.stringify(snapshot), 'codex', reversed);
  expect(parseClientLine(JSON.stringify(record), 'codex', reversed)?.requestId).toBe(first?.requestId);
});

it.each(['fast', 'standard', 'flex', undefined])('maps Claude transcript billing context for speed %s', (speed) => {
  const record = { type: 'assistant', timestamp: '2026-11-01T12:00:00Z', message: {
    id: 'mixed-writes', model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: 1_000_000, speed, cache_creation: { ephemeral_1h_input_tokens: 500_000 } },
  } };
  const parsed = parseClientLine(JSON.stringify(record), 'claude', {})!;
  expect(parsed).toMatchObject({ cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 500_000,
    tier: speed === 'fast' || speed === 'standard' ? speed : null });
  expect(tokenCost(parsed.provider, parsed.model, parsed.at, parsed)?.usd).toBeCloseTo(speed === 'fast' ? 13 : 6.5);
  const withoutLifetime = { ...record, message: { ...record.message, usage: { ...record.message.usage, cache_creation: undefined } } };
  expect(parseClientLine(JSON.stringify(withoutLifetime), 'claude', {})?.cacheWrite1hTokens).toBeNull();
});

it('parses Antigravity PLANNER_RESPONSE lines, splits model/effort, normalizes prompt tokens, strips text, and deduplicates with proxy', () => {
  expect(splitAntigravityModelEffort('gemini-4-neon-high')).toEqual({ model: 'gemini-4-neon', effort: 'high' });
  expect(splitAntigravityModelEffort('claude-opus-5-5-medium')).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
  expect(splitAntigravityModelEffort('gemini-3-flash')).toEqual({ model: 'gemini-3-flash', effort: null });
  const ctx = { session: 'conv-42', client: 'antigravity-cli', authIndex: 'ag-1' };
  const planner = {
    step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: '2026-11-22T22:02:12Z', model: 'gemini-4-neon-medium',
    input_tokens: 13_789, cache_read_tokens: 41_240, output_tokens: 603,
    content: 'PRIVATE_RESPONSE', thinking: 'PRIVATE_THOUGHT', tool_calls: [{ name: 'read_file' }],
  };
  const event = parseClientLine(JSON.stringify(planner), 'antigravity', ctx)!;
  expect(event).toMatchObject({
    provider: 'antigravity', source: 'client-log', client: 'antigravity-cli', upstreamId: null,
    sessionId: 'agy:conv-42', model: 'gemini-4-neon', reasoningEffort: 'medium', authIndex: 'ag-1',
    at: '2026-11-22T22:02:12Z',
    inputTokens: 55_029, cachedTokens: 41_240, cacheWriteTokens: 0, outputTokens: 603,
  });
  expect(JSON.stringify(event)).not.toContain('PRIVATE_');
  expect(parseClientLine(JSON.stringify(planner), 'antigravity', ctx)?.requestId).toBe(event.requestId);
  // Ignores non-completed or non-planner entries.
  expect(parseClientLine(JSON.stringify({ ...planner, status: 'RUNNING' }), 'antigravity', ctx)).toBeNull();
  expect(parseClientLine(JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T22:02:00Z' }), 'antigravity', ctx)).toBeNull();
  // Deduplicates against a matching proxied Antigravity event.
  const proxied = sampleUsage({
    provider: 'antigravity', model: 'gemini-4-neon', sessionId: 'agy:conv-42', client: 'antigravity-cli',
    at: '2026-11-22T22:02:10Z', inputTokens: 55_029, cachedTokens: 41_240, cacheWriteTokens: 0, outputTokens: 603,
  });
  expect(sameUsage(proxied, event)).toBe(true);
  expect(mergeUsage([proxied], [event, event])).toEqual([proxied]);
});

it('tracks Antigravity user turns, thinking presence without retaining text, and parent sessions', () => {
  const ctx: { session?: string; parentSession?: string; sessionKind?: 'subagent'; client?: string; turn?: string } = {
    session: 'child-1', parentSession: 'parent-1', sessionKind: 'subagent', client: 'antigravity-acp',
  };
  expect(parseClientLine(JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T10:00:00Z' }), 'antigravity', ctx)).toBeNull();
  const thought = parseClientLine(JSON.stringify({
    step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:05Z',
    model: 'gemini-4-neon-high', input_tokens: 100, cache_read_tokens: 0, output_tokens: 40, thinking: 'SECRET_THOUGHT',
  }), 'antigravity', ctx)!;
  expect(thought).toMatchObject({
    sessionId: 'agy:child-1', parentSessionId: 'agy:parent-1', sessionKind: 'subagent',
    turnKey: 'agy:0', thinkingTokens: null, hasThinking: true,
  });
  expect(JSON.stringify(thought)).not.toContain('SECRET_THOUGHT');
  // System inputs must not start a new user turn.
  expect(parseClientLine(JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T10:00:06Z' }), 'antigravity', ctx)).toBeNull();
  const noThought = parseClientLine(JSON.stringify({
    step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:00:10Z',
    model: 'gemini-4-neon-high', input_tokens: 100, cache_read_tokens: 0, output_tokens: 20,
  }), 'antigravity', ctx)!;
  expect(noThought).toMatchObject({ turnKey: 'agy:0', thinkingTokens: null, hasThinking: false });
  expect(parseClientLine(JSON.stringify({ step_index: 10, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-22T10:01:00Z' }), 'antigravity', ctx)).toBeNull();
  const nextTurn = parseClientLine(JSON.stringify({
    step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-22T10:01:05Z',
    model: 'gemini-4-neon-high', input_tokens: 100, cache_read_tokens: 0, output_tokens: 20, thinking: '   ',
  }), 'antigravity', ctx)!;
  expect(nextTurn).toMatchObject({ turnKey: 'agy:10', hasThinking: false });
});

it('extracts Codex turnKey and subagent/fork parentSessionId without clobbering subagent sessionId', () => {
  const spawnCtx = {};
  parseClientLine(JSON.stringify({ type: 'session_meta', payload: {
    id: 'sub-1', session_id: 'parent-1', originator: 'codex_cli_rs',
    source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1', depth: 1 } } },
  } }), 'codex', spawnCtx);
  parseClientLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high', turn_id: 'turn-a' } }), 'codex', spawnCtx);
  const subEvent = parseClientLine(JSON.stringify({ timestamp: '2026-11-22T10:00:00Z', type: 'token_usage_record', payload: {
    session_id: 'parent-1', turn_id: 'turn-a', response_id: 'resp_sub',
    usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 40, reasoning_output_tokens: 15 },
  } }), 'codex', spawnCtx)!;
  expect(subEvent).toMatchObject({
    sessionId: 'codex:sub-1', parentSessionId: 'codex:parent-1', sessionKind: 'subagent',
    turnKey: 'codex:turn-a', thinkingTokens: 15, hasThinking: true,
  });

  // Guardian/other subagent where parent comes from session_id !== id, and fallback hash without response_id matches legacy parent hash.
  const otherCtx = {};
  parseClientLine(JSON.stringify({ type: 'session_meta', payload: {
    id: 'guard-1', session_id: 'parent-2', originator: 'codex_cli_rs', source: { subagent: { other: 'guardian' } },
  } }), 'codex', otherCtx);
  parseClientLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'low', turn_id: 'turn-g' } }), 'codex', otherCtx);
  const guardEvent = parseClientLine(JSON.stringify({ timestamp: '2026-11-22T10:01:00Z', type: 'token_usage_record', payload: {
    session_id: 'parent-2', turn_id: 'turn-g',
    usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 },
  } }), 'codex', otherCtx)!;
  const legacyCtx = { session: 'parent-2', turn: 'turn-g', model: 'gpt-6.1-sol' };
  const legacyEvent = parseClientLine(JSON.stringify({ timestamp: '2026-11-22T10:01:00Z', type: 'token_usage_record', payload: {
    session_id: 'parent-2', turn_id: 'turn-g',
    usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 },
  } }), 'codex', legacyCtx)!;
  expect(guardEvent).toMatchObject({
    requestId: legacyEvent.requestId,
    sessionId: 'codex:guard-1', parentSessionId: 'codex:parent-2', sessionKind: 'subagent',
    turnKey: 'codex:turn-g', thinkingTokens: 0, hasThinking: false,
  });

  // Forked session keeps parent link with sessionKind 'fork'.
  const forkCtx = {};
  parseClientLine(JSON.stringify({ type: 'session_meta', payload: { id: 'fork-1', forked_from_id: 'parent-3', originator: 'codex_cli_rs' } }), 'codex', forkCtx);
  parseClientLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'medium', turn_id: 'turn-f' } }), 'codex', forkCtx);
  const forkEvent = parseClientLine(JSON.stringify({ timestamp: '2026-11-22T10:02:00Z', type: 'token_usage_record', payload: {
    session_id: 'fork-1', turn_id: 'turn-f', response_id: 'resp_fork',
    usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
  } }), 'codex', forkCtx)!;
  expect(forkEvent).toMatchObject({ sessionId: 'codex:fork-1', parentSessionId: 'codex:parent-3', sessionKind: 'fork', turnKey: 'codex:turn-f', hasThinking: null });
});

it('tracks Claude prompt turns, subagent parentSessionId, and thinking blocks', () => {
  const rootCtx = {};
  parseClientLine(JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'p1', sessionId: 'root-1', message: { content: 'Fix bug' } }), 'claude', rootCtx);
  // Tool results (including those with attached reminder text) and meta user rows must not start a new turn.
  parseClientLine(JSON.stringify({ type: 'user', uuid: 'u2', promptId: 'p-tool-other', sessionId: 'root-1', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }, { type: 'text', text: '<system-reminder>note</system-reminder>' }] } }), 'claude', rootCtx);
  parseClientLine(JSON.stringify({ type: 'user', uuid: 'u3', promptId: 'p-meta-other', isMeta: true, sessionId: 'root-1', message: { content: 'injected' } }), 'claude', rootCtx);
  const step1 = parseClientLine(JSON.stringify({
    type: 'assistant', timestamp: '2026-11-22T10:00:00Z', sessionId: 'root-1', requestId: 'req1', perTurnEffort: 'high',
    message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'hmm' }], usage: { input_tokens: 10, output_tokens: 20 } },
  }), 'claude', rootCtx)!;
  expect(step1).toMatchObject({
    sessionId: 'claude:root-1', parentSessionId: null, sessionKind: 'root', turnKey: 'claude:p1',
    thinkingTokens: null, hasThinking: true, reasoningEffort: 'high',
  });

  // Legacy Claude transcript without promptId uses non-meta non-tool_result user uuid.
  const legacyCtx = {};
  parseClientLine(JSON.stringify({ type: 'user', uuid: 'u-root', sessionId: 'root-2', message: { content: 'Hello' } }), 'claude', legacyCtx);
  parseClientLine(JSON.stringify({ type: 'user', uuid: 'u-tool', sessionId: 'root-2', message: { content: [{ type: 'tool_result' }] } }), 'claude', legacyCtx);
  parseClientLine(JSON.stringify({ type: 'user', uuid: 'u-meta', isMeta: true, sessionId: 'root-2', message: { content: 'meta' } }), 'claude', legacyCtx);
  const legacyStep = parseClientLine(JSON.stringify({
    type: 'assistant', timestamp: '2026-11-22T10:00:05Z', sessionId: 'root-2', requestId: 'req2', effort: 'medium',
    message: { id: 'msg_2', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { thinking_tokens: 0 } } },
  }), 'claude', legacyCtx)!;
  expect(legacyStep).toMatchObject({ turnKey: 'claude:u-root', thinkingTokens: 0, hasThinking: false, reasoningEffort: 'medium' });

  // Subagent transcript links to parent session with :agent:<id>.
  const subCtx = {};
  parseClientLine(JSON.stringify({ type: 'user', uuid: 'u-sub', promptId: 'p-sub', sessionId: 'root-1', agentId: 'a123', isSidechain: true, message: { content: 'Explore' } }), 'claude', subCtx);
  const subStep = parseClientLine(JSON.stringify({
    type: 'assistant', timestamp: '2026-11-22T10:00:10Z', sessionId: 'root-1', agentId: 'a123', isSidechain: true, requestId: 'req3', perTurnEffort: 'low',
    message: { id: 'msg_3', model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 30, output_tokens_details: { thinking_tokens: 5 } } },
  }), 'claude', subCtx)!;
  expect(subStep).toMatchObject({
    sessionId: 'claude:root-1:agent:a123', parentSessionId: 'claude:root-1', sessionKind: 'subagent',
    turnKey: 'claude:p-sub', thinkingTokens: 5, hasThinking: true,
  });
  expect(sameUsage(sampleUsage({ sessionId: 'claude:root-1', inputTokens: 10, outputTokens: 30, cachedTokens: 0, cacheWriteTokens: 0, at: '2026-11-22T10:00:10Z' }), subStep)).toBe(true);
});
