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
      output_tokens: 0, cached_tokens: 0,
    }));
    expect(e).toMatchObject({ requestId: 'r1', provider: 'claude', model: 'fable', failed: true, statusCode: 529, ttftMs: null });
  });

  it('rejects malformed events', () => {
    expect(parseActivityEvent('not json')).toBeNull();
    expect(parseActivityEvent('{"provider":"claude"}')).toBeNull();
  });
});
