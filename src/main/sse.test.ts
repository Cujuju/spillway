import { describe, expect, it } from 'vitest';
import { parseActivityEvent, SseParser } from './sse';

describe('SseParser', () => {
  it('joins messages split across chunks and skips comments', () => {
    const p = new SseParser();
    expect(p.push('event: ready\ndata: {}\n\n: keep-alive\n\nevent: req')).toEqual([{ event: 'ready', data: '{}' }]);
    expect(p.push('uest\r\ndata: {"a":1}\r\n\r\n')).toEqual([{ event: 'request', data: '{"a":1}' }]);
  });

  it('joins multi-line data', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});

describe('parseActivityEvent', () => {
  it('preserves observed transport metadata without inferring historical transports', () => {
    expect(parseActivityEvent(JSON.stringify({ request_id: 'old', stream: true, executor_type: 'CodexWebsocketsExecutor' })))
      .toMatchObject({ downstreamTransport: null, upstreamTransport: null, transportFallbackReason: null });
    expect(parseActivityEvent(JSON.stringify({ request_id: 'attempt', downstream_transport: 'http', upstream_transport: 'websocket+http', transport_fallback_reason: 'websocket_upgrade_426' })))
      .toMatchObject({ downstreamTransport: 'http', upstreamTransport: 'websocket+http', transportFallbackReason: 'websocket_upgrade_426' });
    expect(parseActivityEvent(JSON.stringify({ request_id: 'bad', downstream_transport: 'sse', upstream_transport: 1, transport_fallback_reason: 'raw error body' })))
      .toMatchObject({ downstreamTransport: null, upstreamTransport: null, transportFallbackReason: null });
  });
  it('maps the proxy fields and prefers the client alias for the model', () => {
    const e = parseActivityEvent(JSON.stringify({
      at: '2026-10-25T12:00:00Z', request_id: 'r1', selection_id: 's1', provider: 'Claude', model: 'claude-x', alias: 'fable',
      auth_index: 'a1', stream: true, failed: true, status_code: 529, error: 'overloaded', latency_ms: 50, input_tokens: 10,
      output_tokens: 0, cached_tokens: 0, cache_creation_tokens: 40,
    }));
    expect(e).toMatchObject({ requestId: 'r1', cacheWriteTokens: 40, provider: 'claude', model: 'fable', failed: true, statusCode: 529, ttftMs: null, sessionId: null });
  });

  it('keeps the conversation the proxy keyed the request by', () => {
    expect(parseActivityEvent(JSON.stringify({ request_id: 'r1', session_id: 'claude:abc' }))).toMatchObject({ sessionId: 'claude:abc', movedFrom: null });
  });

  it('keeps effective model and effort separate from the requested alias and unknown metadata', () => {
    expect(parseActivityEvent(JSON.stringify({ request_id: 'r', alias: 'coding', model: 'gpt-5', reasoning_effort: '8192', parent_session_id: 'codex:parent' })))
      .toMatchObject({ model: 'coding', effectiveModel: 'gpt-5', reasoningEffort: '8192', parentSessionId: 'codex:parent', latencyMs: null });
    expect(parseActivityEvent(JSON.stringify({ request_id: 'old', model: 'gpt-5' })))
      .toMatchObject({ reasoningEffort: null, parentSessionId: null, latencyMs: null });
  });

  it('keeps the client that sent the request', () => {
    expect(parseActivityEvent(JSON.stringify({ request_id: 'r1', user_agent: 'codex_cli_rs/0.164.0' }))?.userAgent).toBe('codex_cli_rs/0.164.0');
    expect(parseActivityEvent(JSON.stringify({ request_id: 'r1' }))?.userAgent).toBeNull();
  });

  it('rejects malformed events', () => {
    expect(parseActivityEvent('not json')).toBeNull();
    expect(parseActivityEvent('{"provider":"claude"}')).toBeNull();
  });

  it("drops the app's own window-start requests", () => {
    expect(parseActivityEvent(JSON.stringify({ request_id: 'r2', provider: 'claude', purpose: 'window-start' }))).toBeNull();
  });
});


it('preserves the upstream response ID and tags live events as proxy usage', () => {
  expect(parseActivityEvent(JSON.stringify({ request_id: 'proxy_request', upstream_id: 'msg_response' })))
    .toMatchObject({ upstreamId: 'msg_response', source: 'proxy' });
  expect(parseActivityEvent(JSON.stringify({ request_id: 'older_proxy' }))?.upstreamId).toBeNull();
});
