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
