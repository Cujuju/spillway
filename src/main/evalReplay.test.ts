import { afterEach, expect, it, vi } from 'vitest';
import { EVAL_LIMITS } from '@shared/evalCase';
import { compareOutput, EvalReplay, replayDestination, replayPreview } from './evalReplay';
import { evalFixture } from './test/evalFixtures';

const target = { endpoint: 'http://127.0.0.1:8317', clientApiKey: 'synthetic-test-key' };
const answer = (text = 'hello') => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
afterEach(() => vi.useRealTimers());
it('labels imported content without transformation metadata as unverified before execution', () => {
  const c = evalFixture(); c.provenance = { source: 'portable-import', archiveId: c.capture.entry.id, importedFrom: 'claimed-origin' };
  const p = replayPreview(c, target); expect(p.inputFidelity).toContain('unverified transformation history'); expect(p.inputFidelity).toContain('may have altered input and assertions');
});
it('preview performs no call; explicit start uses current trusted endpoint/auth, bounded context and literal criteria', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer());
  const replay = new EvalReplay(() => target, fetcher), c = evalFixture(), p = replay.prepare(c);
  expect(fetcher).not.toHaveBeenCalled(); expect(p).toMatchObject({ supported: true, route: '/v1/chat/completions', mode: 'model-call', agentTask: 'unsupported', maxOutputTokens: 16 });
  p.request = 'malicious replacement'; p.assertions = [];
  expect(replay.start(p.id).state).toBe('running');
  await vi.waitFor(() => expect(replay.status(p.id).state).toBe('complete'));
  expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8317/v1/chat/completions', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-test-key' }) }));
  const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
  expect(body).toMatchObject({ stream: false, model: 'synthetic-model', max_tokens: 16, messages: c.capture.payload.data && JSON.parse(c.capture.payload.data.request).messages });
  expect(replay.status(p.id)).toMatchObject({ comparison: 'pass', taskOutcome: 'unknown', httpStatus: 200, output: 'hello' });
  expect(() => replay.start(p.id)).toThrow();
});
it('compares only explicit literal text assertions; HTTP success can fail criteria and never proves task success', async () => {
  expect(compareOutput('Hello', [{ kind: 'contains', value: 'hello' }, { kind: 'not-contains', value: '$()' }, { kind: 'equals', value: 'Hello' }]).map((x) => x.passed)).toEqual([false, true, true]);
  const replay = new EvalReplay(() => target, vi.fn<typeof fetch>().mockResolvedValue(answer('incorrect'))), p = replay.prepare(evalFixture()); replay.start(p.id);
  await vi.waitFor(() => expect(replay.status(p.id).comparison).toBe('fail')); expect(replay.status(p.id).taskOutcome).toBe('unknown');
});
it('supports text-only Anthropic JSON on its fixed route without running captured tool commands', async () => {
  const c = evalFixture(); c.capture.entry.path = '/v1/messages'; c.capture.payload.data!.request = JSON.stringify({ model: 'synthetic-claude', max_tokens: 10_000, system: [{ type: 'text', text: 'Answer text only' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] }));
  const replay = new EvalReplay(() => target, fetcher), p = replay.prepare(c); expect(p.maxOutputTokens).toBe(2048); replay.start(p.id);
  await vi.waitFor(() => expect(replay.status(p.id).comparison).toBe('pass'));
  expect(fetcher.mock.calls[0]![0]).toBe(`${target.endpoint}/v1/messages`);
});
it.each(['partial', 'pending', 'missing', 'expired', 'unknown'] as const)('rejects %s capture state even with retained text', (state) => {
  const c = evalFixture(); c.capture.entry.state = state; expect(replayPreview(c, target).supported).toBe(false);
});
it('rejects opaque/missing protocol, WS/Responses, stateful tools, remote attachments and arbitrary request extensions', () => {
  for (const edit of [
    (c: ReturnType<typeof evalFixture>) => { c.capture.entry.path = '/backend-api/codex/responses'; },
    (c: ReturnType<typeof evalFixture>) => { c.capture.entry.path = 'https://attacker.invalid/v1/messages'; },
    (c: ReturnType<typeof evalFixture>) => { c.capture.payload.data!.format = 'websocket'; },
    (c: ReturnType<typeof evalFixture>) => { c.capture.payload.state = 'omitted'; c.capture.payload.data = null; },
    (c: ReturnType<typeof evalFixture>) => { c.capture.payload.data!.requestDecoded = false; c.capture.payload.data!.requestEncoding = 'gzip'; },
    (c: ReturnType<typeof evalFixture>) => { c.annotation.assertions = []; },
    (c: ReturnType<typeof evalFixture>) => { c.capture.payload.data!.request = 'a'.repeat(EVAL_LIMITS.requestBytes + 1); },
    (c: ReturnType<typeof evalFixture>) => { c.capture.payload.data!.request = JSON.stringify({ model: 'x', tools: [{ command: 'rm -rf /' }], messages: [{ role: 'user', content: 'text' }] }); },
    (c: ReturnType<typeof evalFixture>) => { c.capture.payload.data!.request = JSON.stringify({ model: 'x', previous_response_id: 'stateful', messages: [] }); },
    (c: ReturnType<typeof evalFixture>) => { c.capture.payload.data!.request = JSON.stringify({ model: 'x', messages: [{ role: 'tool', content: 'tool results' }] }); },
    (c: ReturnType<typeof evalFixture>) => { c.capture.payload.data!.request = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://attacker.invalid' }] }] }); },
  ]) { const c = evalFixture(); edit(c); const replay = new EvalReplay(() => target, vi.fn()), p = replay.prepare(c); expect(p.supported).toBe(false); expect(() => replay.start(p.id)).toThrow(); }
});
it('blocks non-local endpoints, userinfo, query strings, alternate routes and changed current credentials', () => {
  for (const endpoint of ['https://attacker.invalid', 'http://127.0.0.1@attacker.invalid', 'http://user:password@127.0.0.1:8317', 'http://127.0.0.1:8317/v1', 'http://127.0.0.1:8317?key=x', 'http://127.0.0.1:8317#fragment']) expect(() => replayDestination({ ...target, endpoint }, '/v1/messages')).toThrow();
  expect(() => replayDestination(target, '/v0/management/config')).toThrow();
  let current = { ...target }; const fetcher = vi.fn<typeof fetch>(), replay = new EvalReplay(() => current, fetcher), p = replay.prepare(evalFixture()); current = { ...target, clientApiKey: 'new-key' };
  expect(() => replay.start(p.id)).toThrow('changed'); expect(fetcher).not.toHaveBeenCalled();
});
it('cancels previews and in-flight clients without allowing a late response to pass', async () => {
  let complete!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const replay = new EvalReplay(() => target, fetcher), canceled = replay.prepare(evalFixture()); replay.cancel(canceled.id); expect(() => replay.start(canceled.id)).toThrow();
  const p = replay.prepare(evalFixture()); replay.start(p.id); expect(() => replay.prepare(evalFixture())).toThrow('Cancel'); replay.cancel(p.id); complete(answer());
  await Promise.resolve(); await Promise.resolve(); expect(replay.status(p.id)).toMatchObject({ state: 'canceled', comparison: 'not-evaluated', output: '' });
  expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
  replay.forget(p.caseId); expect(() => replay.status(p.id)).toThrow();
});
it('deadline bounds a client that never responds and preview expiry cannot start', async () => {
  vi.useFakeTimers(); const replay = new EvalReplay(() => target, vi.fn<typeof fetch>().mockReturnValue(new Promise(() => {})));
  const expired = replay.prepare(evalFixture()); await vi.advanceTimersByTimeAsync(5 * 60_000 + 1); expect(() => replay.start(expired.id)).toThrow();
  const p = replay.prepare(evalFixture()); replay.start(p.id); await vi.advanceTimersByTimeAsync(EVAL_LIMITS.timeoutMs + 1);
  expect(replay.status(p.id)).toMatchObject({ state: 'failed', comparison: 'not-evaluated', output: '' });
});
it.each([
  () => new Response('private error text', { status: 401 }),
  () => new Response('data: [DONE]', { headers: { 'content-type': 'text/event-stream' } }),
  () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'hello' } }] }),
  () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'hello', tool_calls: [{ command: 'do not run' }] } }] }),
  () => Response.json({ error: { message: 'synthetic failure' } }),
  () => new Response('{not JSON}', { headers: { 'content-type': 'application/json' } }),
  () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
  () => answer('hello'.repeat(EVAL_LIMITS.outputBytes)),
  () => answer('a'.repeat(EVAL_LIMITS.outputBytes + 1)),
])('fails bounded transport/protocol/incomplete results without asserting success', async (response) => {
  const replay = new EvalReplay(() => target, vi.fn<typeof fetch>().mockResolvedValue(response())), p = replay.prepare(evalFixture()); replay.start(p.id);
  await vi.waitFor(() => expect(replay.status(p.id).state).toBe('failed'));
  expect(replay.status(p.id)).toMatchObject({ comparison: 'not-evaluated', taskOutcome: 'unknown', output: '' }); expect(replay.status(p.id).error).not.toContain('private error text');
});
it('cancels while reading a stalled response body', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } });
  const replay = new EvalReplay(() => target, vi.fn<typeof fetch>().mockResolvedValue(response)), p = replay.prepare(evalFixture()); replay.start(p.id);
  await Promise.resolve(); replay.cancel(p.id); await Promise.resolve(); expect(replay.status(p.id).state).toBe('canceled');
});
