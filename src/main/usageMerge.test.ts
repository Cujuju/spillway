import { describe, expect, it } from 'vitest';
import { mergeUsage, sameUsage, USAGE_MATCH_TOLERANCE_MS } from './usageMerge';
import { parseClientLine } from './clientLogParser';
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
