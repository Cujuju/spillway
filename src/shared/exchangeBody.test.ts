import { describe, expect, it } from 'vitest';
import { CAPTURE_BODY_LIMIT, type ArchiveDetail, type CaptureFrame } from './archive';
import { readableStreamText } from './archiveContent';
import { exchangeSide } from './exchangeBody';

type Detail = Pick<ArchiveDetail, 'request' | 'response' | 'frames' | 'format' | 'reason'>;
const detail = (patch: Partial<Detail> = {}): Detail => ({ request: '', response: '', frames: [], format: 'http', reason: '', ...patch });
const request = (value: unknown) => exchangeSide(detail({ request: JSON.stringify(value) }), 'request');
const response = (value: unknown) => exchangeSide(detail({ response: JSON.stringify(value) }), 'response');
const frame = (direction: 'request' | 'response', value: unknown, truncated = false): CaptureFrame => ({ index: 1, direction, at: '', type: 'text', payload: typeof value === 'string' ? value : JSON.stringify(value), truncated });
const text = (text: string) => ({ kind: 'text', text });

describe('exchangeSide', () => {
  it('keeps raw bodies and pretty prints strict JSON beyond 32 KiB', () => {
    const value = { messages: [{ role: 'user', content: 'x'.repeat(40 * 1024) }] };
    const side = request(value);
    expect(side.raw).toBe(JSON.stringify(value));
    expect(side.pretty).toBe(JSON.stringify(value, null, 2));
    expect(side.messages).toEqual([{ role: 'user', parts: [text(value.messages[0]!.content)] }]);
    expect(side.cut).toBe(false);
  });

  it('reads Anthropic system blocks, thinking, calls, results and media; skips tool definitions', () => {
    expect(request({ system: [{ type: 'text', text: 'System' }], tools: [{ name: 'not_a_call' }], messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Consider' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'One' }, { type: 'text', text: 'Two' }] }, { type: 'image', source: { media_type: 'image/png' } }, { type: 'document', source: { media_type: 'application/pdf' } }] },
      { role: 'user', content: [{ type: 'unknown', text: 'ignored' }] },
    ] }).messages).toEqual([
      { role: 'system', parts: [text('System')] }, { role: 'user', parts: [text('Hello')] },
      { role: 'assistant', parts: [{ kind: 'thinking', text: 'Consider' }, { kind: 'thinking', text: 'Redacted thinking' }, { kind: 'tool-call', name: 'lookup', text: '{\n  "query": "a"\n}' }] },
      { role: 'user', parts: [{ kind: 'tool-result', name: 'lookup', text: 'One\nTwo' }, { kind: 'media', text: 'image/png' }, { kind: 'media', text: 'application/pdf' }] },
    ]);
    expect(request({ system: 'Plain system' }).messages).toEqual([{ role: 'system', parts: [text('Plain system')] }]);
    expect(response({ role: 'assistant', content: [{ type: 'text', text: 'Answer' }, { type: 'tool_use', name: 'next', input: {} }] }).messages).toEqual([
      { role: 'assistant', parts: [text('Answer'), { kind: 'tool-call', name: 'next', text: '{}' }] },
    ]);
  });

  it('reads OpenAI Chat parts and function arguments, preserving unparseable arguments', () => {
    expect(request({ messages: [
      { role: 'developer', content: 'Be concise' },
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }, { id: 'c2', function: { name: 'unfinished', arguments: '{"q":' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'Found' }, { role: 'tool', tool_call_id: 'unknown', content: 'Unknown' },
    ] }).messages).toEqual([
      { role: 'developer', parts: [text('Be concise')] },
      { role: 'user', parts: [text('Look'), { kind: 'media', text: 'image/jpeg' }] },
      { role: 'assistant', parts: [{ kind: 'tool-call', name: 'search', text: '{\n  "q": "x"\n}' }, { kind: 'tool-call', name: 'unfinished', text: '{"q":' }] },
      { role: 'tool', parts: [{ kind: 'tool-result', name: 'search', text: 'Found' }] },
      { role: 'tool', parts: [{ kind: 'tool-result', name: 'unknown', text: 'Unknown' }] },
    ]);
    expect(response({ choices: [{ message: { role: 'assistant', reasoning_content: 'Consider first', content: 'First' } }, { message: { role: 'assistant', tool_calls: [{ function: { name: 'next', arguments: '{}' } }] } }] }).messages).toEqual([
      { role: 'assistant', parts: [{ kind: 'thinking', text: 'Consider first' }, text('First')] }, { role: 'assistant', parts: [{ kind: 'tool-call', name: 'next', text: '{}' }] },
    ]);
  });

  it('reads Responses instructions, messages, calls, results and reasoning', () => {
    expect(request({ instructions: 'System', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }, { type: 'input_image', image_url: 'https://example.com/image.png' }] },
      { type: 'function_call', name: 'lookup', call_id: 'c', arguments: '{"id":1}' },
      { type: 'function_call_output', call_id: 'c', output: [{ type: 'output_text', text: 'Result' }] },
      { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** End Patch' },
      { type: 'custom_tool_call_output', call_id: 'patch', output: 'Applied' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thought one' }, { text: 'Thought two' }] },
    ] }).messages).toEqual([
      { role: 'system', parts: [text('System')] },
      { role: 'user', parts: [text('Question'), { kind: 'media', text: 'image' }] },
      { role: 'assistant', parts: [{ kind: 'tool-call', name: 'lookup', text: '{\n  "id": 1\n}' }] },
      { role: 'tool', parts: [{ kind: 'tool-result', name: 'lookup', text: 'Result' }] },
      { role: 'assistant', parts: [{ kind: 'tool-call', name: 'apply_patch', text: '*** Begin Patch\n*** End Patch' }] },
      { role: 'tool', parts: [{ kind: 'tool-result', name: 'apply_patch', text: 'Applied' }] },
      { role: 'assistant', parts: [{ kind: 'thinking', text: 'Thought one\nThought two' }] },
    ]);
    expect(request({ input: [{ role: 'user', content: [
      { type: 'input_file', filename: 'report.pdf', mime_type: 'application/pdf' }, { type: 'input_file', mime_type: 'text/plain' },
      { type: 'input_file', file_data: 'data:application/pdf;base64,AA==' }, { type: 'input_file', file_id: 'file-1' },
    ] }] }).messages).toEqual([{ role: 'user', parts: [{ kind: 'media', text: 'report.pdf' }, { kind: 'media', text: 'text/plain' }, { kind: 'media', text: 'application/pdf' }, { kind: 'media', text: 'file' }] }]);
    expect(request({ input: 'Simple input' }).messages).toEqual([{ role: 'user', parts: [text('Simple input')] }]);
    expect(response({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] }, { type: 'function_call_output', output: 'No id' }] }).messages).toEqual([
      { role: 'assistant', parts: [text('Answer')] }, { role: 'tool', parts: [{ kind: 'tool-result', name: '', text: 'No id' }] },
    ]);
  });

  it('reads Gemini system instructions, messages, function calls and responses', () => {
    expect(request({ systemInstruction: { parts: [{ text: 'System' }] }, contents: [
      { role: 'user', parts: [{ text: 'Question' }, { inlineData: { mimeType: 'image/png', data: 'AA==' } }] },
      { role: 'model', parts: [{ functionCall: { name: 'weather', args: { city: 'LA' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'weather', response: { temperature: 20 } } }] },
    ] }).messages).toEqual([
      { role: 'system', parts: [text('System')] },
      { role: 'user', parts: [text('Question'), { kind: 'media', text: 'image/png' }] },
      { role: 'model', parts: [{ kind: 'tool-call', name: 'weather', text: '{\n  "city": "LA"\n}' }] },
      { role: 'user', parts: [{ kind: 'tool-result', name: 'weather', text: '{\n  "temperature": 20\n}' }] },
    ]);
    expect(response({ candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'Consider' }, { text: 'Answer' }] } }] }).messages).toEqual([{ role: 'model', parts: [{ kind: 'thinking', text: 'Consider' }, text('Answer')] }]);
  });

  it.each([
    ['{"messages":[{"role":"user","content":"hel', 'hel'],
    ['{"messages":[{"role":"user","content":"hello\\', 'hello'],
    ['{"messages":[{"role":"user","content":"hello\\u12', 'hello'],
    ['{"messages":[{"role":"user","content":"a\\n\\u263a', 'a\n☺'],
    ['{"messages":[{"role":"user","content":"ok"}, {"role":', 'ok'],
    ['{"messages":[{"role":"user","content":"ok"}],"dangling', 'ok'],
    ['{"messages":[{"role":"user","content":"ok"}],"n":tru', 'ok'],
    ['{"messages":[{"role":"user","content":"ok"}],"n":-1.2e+', 'ok'],
    ['{"messages":[{"role":"user","content":"ok"}],"n":', 'ok'],
  ])('recovers a cut tail: %s', (raw, expected) => {
    const side = exchangeSide(detail({ request: raw }), 'request');
    expect(side.pretty).toBeNull();
    expect(side.messages).toEqual([{ role: 'user', parts: [text(expected)] }]);
  });

  it('recovers nested tool input, complete literals and a dangling key without changing raw', () => {
    const raw = '{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"c","name":"tool","input":{"yes":true,"no":false,"empty":null,"n":-1.5e2,"nested":[1,{"value":"partial';
    const side = exchangeSide(detail({ request: raw }), 'request');
    expect(side.raw).toBe(raw);
    expect(side.messages?.[0]?.parts).toEqual([{ kind: 'tool-call', name: 'tool', text: JSON.stringify({ yes: true, no: false, empty: null, n: -150, nested: [1, { value: 'partial' }] }, null, 2) }]);
    const keyCut = raw.slice(0, raw.indexOf('"nested"')) + '"unfinished';
    expect(exchangeSide(detail({ request: keyCut }), 'request').messages?.[0]?.parts).toEqual([{ kind: 'tool-call', name: 'tool', text: JSON.stringify({ yes: true, no: false, empty: null, n: -150 }, null, 2) }]);
  });

  it('recovers a full 256 KiB prefix with many earlier messages and a partial string', () => {
    const history = Array.from({ length: 100 }, () => ({ role: 'assistant', content: 'Earlier message' }));
    const raw = JSON.stringify({ messages: [...history, { role: 'user', content: 'x'.repeat(CAPTURE_BODY_LIMIT) }] }).slice(0, CAPTURE_BODY_LIMIT);
    const side = exchangeSide(detail({ request: raw }), 'request');
    expect(new TextEncoder().encode(side.raw).length).toBe(CAPTURE_BODY_LIMIT);
    expect(side.cut).toBe(true);
    expect(side.pretty).toBeNull();
    expect(side.messages).toHaveLength(history.length + 1);
    expect(side.messages?.at(-1)?.parts[0]?.text).toBe('x'.repeat(raw.length - raw.indexOf('xxx')));
  });

  it('uses UTF-8 bytes per HTTP side, independent of record reason', () => {
    const value = detail({ request: 'é'.repeat(CAPTURE_BODY_LIMIT / 2), response: '{}', reason: 'connection-cancelled' });
    expect(exchangeSide(value, 'request').cut).toBe(true);
    expect(exchangeSide(value, 'response').cut).toBe(false);
    expect(exchangeSide(detail({ request: 'x'.repeat(CAPTURE_BODY_LIMIT - 1) }), 'request').cut).toBe(false);
    expect(exchangeSide(detail({ request: 'x'.repeat(CAPTURE_BODY_LIMIT - 1) + '�' }), 'request').cut).toBe(true);
    expect(exchangeSide(detail({ request: 'short', reason: 'byte-limit' }), 'request').cut).toBe(false);
  });

  it('counts decoded Base64 wire bytes, including padding', () => {
    for (const bytes of [CAPTURE_BODY_LIMIT - 2, CAPTURE_BODY_LIMIT - 1, CAPTURE_BODY_LIMIT, CAPTURE_BODY_LIMIT + 1]) {
      const raw = 'Base64 wire body:\n' + btoa('x'.repeat(bytes));
      const side = exchangeSide(detail({ request: raw }), 'request');
      expect(side.cut).toBe(bytes >= CAPTURE_BODY_LIMIT);
      expect(side.messages).toBeNull();
    }
  });

  it('exposes only that direction’s frame payloads and reads both Codex create envelopes', () => {
    const first = frame('request', { type: 'response.create', instructions: 'Top-level', input: 'First' });
    const second = frame('request', { type: 'response.create', response: { instructions: 'Nested', input: [{ type: 'message', role: 'user', content: 'Second' }] } });
    const value = detail({ format: 'websocket', request: 'Stored decorated frames', frames: [first, frame('response', { delta: 'Answer' }), second] });
    const side = exchangeSide(value, 'request');
    expect(side.raw).toBe(first.payload + '\n\n' + second.payload);
    expect(side.pretty).toBeNull();
    expect(side.messages).toEqual([{ role: 'system', parts: [text('Top-level')] }, { role: 'user', parts: [text('First')] }, { role: 'system', parts: [text('Nested')] }, { role: 'user', parts: [text('Second')] }]);
    expect(exchangeSide(detail({ format: 'websocket', frames: [first] }), 'request').pretty).toBe(JSON.stringify(JSON.parse(first.payload), null, 2));
    expect(exchangeSide(detail({ format: 'websocket', request: 'ignored' }), 'request').raw).toBe('');
  });

  it('detects WebSocket cuts per direction without counting separators', () => {
    const value = detail({ format: 'websocket', frames: [frame('request', 'small', true), frame('response', 'ok')] });
    expect(exchangeSide(value, 'request').cut).toBe(true);
    expect(exchangeSide(value, 'response').cut).toBe(false);
    const frames = [frame('request', 'é'.repeat(CAPTURE_BODY_LIMIT / 4)), frame('request', 'x'.repeat(CAPTURE_BODY_LIMIT / 2 - 1))];
    expect(exchangeSide(detail({ format: 'websocket', frames }), 'request').cut).toBe(false);
    frames.push(frame('request', 'x'));
    expect(exchangeSide(detail({ format: 'websocket', frames }), 'request').cut).toBe(true);
    for (const direction of ['request', 'response'] as const) expect(exchangeSide(detail({ format: 'websocket', reason: 'websocket-frame-count-limit' }), direction).cut).toBe(true);
  });

  it('reuses readableStreamText for SSE and response deltas without including request frames', () => {
    const raw = 'event: content_block_delta\ndata: {"delta":{"text":"Hello\\n"}}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: [DONE]\n\ndata: {"delta":{"text":"cut';
    expect(exchangeSide(detail({ response: raw }), 'response').messages).toEqual([{ role: 'assistant', parts: [text(readableStreamText(raw))] }]);
    const frames = [frame('request', { delta: 'Wrong' }), frame('response', { type: 'response.output_text.delta', delta: 'One' }), frame('response', { delta: { text: 'Two' } })];
    const side = exchangeSide(detail({ format: 'websocket', frames }), 'response');
    expect(side.messages).toEqual([{ role: 'assistant', parts: [text('OneTwo')] }]);
    expect(side.raw).toBe(frames.slice(1).map((f) => f.payload).join('\n\n'));
  });

  it.each(['', 'plain text', '{"unrecognised":true}', '{"messages":[{"role":"user","content":[]}]}', '{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":""}]}]}', 'data: [DONE]\n\n'])('returns no messages for empty or unknown shapes: %s', (raw) => {
    expect(exchangeSide(detail({ request: raw }), 'request').messages).toBeNull();
  });
});
