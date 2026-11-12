import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { ArchiveDetail } from '@shared/archive';
import type { ThinkingTest } from '@shared/thinkingTest';
import type { ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { ActivityLog } from './activityStore';
import { assembleResponse, exactTools, nextMove, parseJudge, rewriteTestBody } from './thinkingTestCodec';
import { capturedRequest, prepareTest, stratify, TEST_PLAN_TTL_MS, type PreparedTest } from './thinkingTestPlan';
import { ThinkingTestRunner, testResults } from './thinkingTestRunner';

const setting = { provider: 'claude', model: 'claude-sonnet-4-6', effort: 'high' };
const alternative = { ...setting, effort: 'low' };
const tool = { type: 'tool_use', id: 'ignored', name: 'read', input: { path: 'a', options: { b: 2, a: 1 } } };
const response = JSON.stringify({ content: [tool], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } });
const body = { model: setting.model, tools: [{ name: 'read' }], messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }], max_tokens: 1024, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, stream: true };
const prepared = (): PreparedTest => ({ plan: { id: crypto.randomUUID(), setting, alternatives: [alternative], sampled: [{ kind: 'question', turns: 1 }], eligibleTurns: 1, replayableTurns: 1, skipped: [], estimatedCostUsd: 0, expiresAt: new Date(Date.now() + TEST_PLAN_TTL_MS).toISOString() }, shares: { question: 0.8, change: 0.2, long: 0 }, samples: [{ turnAt: new Date().toISOString(), traceId: 'synthetic', kind: 'question', route: '/v1/messages', body, response, event: {} as ActivityEvent }] });
const target = { endpoint: 'http://127.0.0.1:1234', clientApiKey: 'synthetic' };

it('stratifies evenly and redistributes leftovers without duplicates', () => {
  const items = [...Array.from({ length: 1 }, (_, id) => ({ id, kind: 'question' as const })), ...Array.from({ length: 8 }, (_, id) => ({ id, kind: 'change' as const })), ...Array.from({ length: 8 }, (_, id) => ({ id, kind: 'long' as const }))];
  const sampled = stratify(items, 10, () => 0);
  expect(sampled.map((s) => s.kind).filter((k) => k === 'question')).toHaveLength(1);
  expect(sampled.filter((s) => s.kind === 'change')).toHaveLength(5);
  expect(sampled.filter((s) => s.kind === 'long')).toHaveLength(4);
  expect(new Set(sampled).size).toBe(10);
});
it('rewrites Claude adaptive and manual effort and Responses without dropping tools/history', () => {
  expect(rewriteTestBody(body, '/v1/messages', alternative)).toMatchObject({ model: alternative.model, output_config: { effort: 'low' }, stream: false, tools: body.tools, messages: body.messages, max_tokens: 1024 });
  expect(rewriteTestBody({ ...body, output_config: undefined, thinking: { type: 'enabled', budget_tokens: 8192 } }, '/v1/messages', alternative).thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  expect(rewriteTestBody({ ...body, max_tokens: 64000 }, '/v1/messages', alternative).stream).toBe(true);
  expect(rewriteTestBody({ model: 'old', input: body.messages, tools: body.tools, reasoning: { effort: 'high' } }, '/v1/responses', alternative)).toEqual({ model: alternative.model, input: body.messages, tools: body.tools, reasoning: { effort: 'low' }, stream: false });
});
it('extracts JSON moves in all protocols and compares tool inputs deeply', () => {
  const a = nextMove(assembleResponse(response));
  const b = nextMove({ output: [{ type: 'function_call', name: 'read', arguments: '{"options":{"a":1,"b":2},"path":"a"}' }] });
  expect(exactTools(a, b)).toBe(true);
  expect(exactTools({ ...a, text: "I'll read the file." }, { ...b, text: 'Checking now.' })).toBe(true);
  expect(exactTools({ text: 'same', tools: [] }, { text: 'same', tools: [] })).toBe(false);
  expect(exactTools(a, { ...b, tools: [{ name: 'read', input: { path: 'other' } }] })).toBe(false);
  expect(nextMove({ choices: [{ message: { content: 'answer' } }] }).text).toBe('answer');
  expect(() => nextMove({ content: [], stop_reason: 'max_tokens' })).toThrow();
});
it('assembles Claude, chat and Responses SSE and rejects unfinished streams', () => {
  const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  expect(nextMove(assembleResponse(sse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'read', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }, { type: 'message_stop' }]))).tools).toEqual([{ name: 'read', input: { path: 'a' } }]);
  expect(nextMove(assembleResponse(sse([{ choices: [{ delta: { content: 'hello' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]))).text).toBe('hello');
  expect(nextMove(assembleResponse(sse([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'yes' }] }] } }]))).text).toBe('yes');
  expect(() => assembleResponse(sse([{ type: 'message_start', message: {} }]))).toThrow('Incomplete');
});
it('parses strict judge verdicts and rejects malformed answers', () => {
  for (const verdict of ['match', 'differ']) expect(parseJudge(JSON.stringify({ verdict, reason: 'Same intent.' })).outcome).toBe(verdict);
  for (const text of ['{}', 'not JSON', '{"verdict":"match","reason":1}']) expect(() => parseJudge(text)).toThrow();
});
it('reports plain skip reasons for incomplete, uncaptured, unsupported and stateful traffic', () => {
  const d = { state: 'complete', method: 'POST', path: '/v1/responses', format: 'http', request: '{"model":"synthetic","input":"hi"}', response: '{"output":[{"type":"message","content":[{"type":"output_text","text":"yes"}]}]}', requestEncoding: '', responseEncoding: '' } as ArchiveDetail;
  expect(capturedRequest(d).body).toEqual({ model: 'synthetic', input: 'hi' });
  expect(() => capturedRequest(null)).toThrow('turn on request capture');
  expect(() => capturedRequest({ ...d, state: 'partial' })).toThrow('body incomplete');
  expect(() => capturedRequest({ ...d, format: 'websocket' })).toThrow('earlier server state');
  expect(() => capturedRequest({ ...d, request: '{"model":"synthetic","input":"hi","previous_response_id":"x"}' })).toThrow('earlier server state');
  expect(() => capturedRequest({ ...d, path: '/unknown' })).toThrow('unsupported request route');
  expect(() => capturedRequest({ ...d, request: '{"model":"synthetic","input":"hi","tools":[{"type":"web_search"}]}' })).toThrow('server-executed tools');
  expect(() => capturedRequest({ ...d, request: '{"model":"synthetic","input":[{"type":"item_reference","id":"x"}]}' })).toThrow('earlier server state');
});
it('matches identical tools without invoking a judge, binds auth, expires and consumes plans once', async () => {
  let auth = target;
  const fetcher = vi.fn(async () => new Response(response, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  let saved: ThinkingTest | undefined;
  const runner = new ThinkingTestRunner(() => auth, async (t) => { saved = t; }, fetcher);
  const p = prepared(); runner.prepare(p); runner.start(p.plan.id);
  expect(() => runner.start(p.plan.id)).toThrow('already used');
  await vi.waitFor(() => expect(saved?.state).toBe('complete'));
  expect(fetcher).toHaveBeenCalledTimes(1); expect(saved?.results[0]).toMatchObject({ matched: 1, graded: 1, errors: 0, weightedMatchShare: 1 });
  const call = vi.mocked(fetcher).mock.calls[0]!;
  expect(String(call[0])).toBe('http://127.0.0.1:1234/v1/messages');
  expect(call[1]?.headers).toMatchObject({ 'X-CPA-Purpose': 'thinking-test', 'X-Api-Key': 'synthetic' });
  const expired = prepared(); expired.plan.expiresAt = new Date(Date.now() - 1).toISOString(); runner.prepare(expired); expect(() => runner.start(expired.plan.id)).toThrow('expired');
  const changed = prepared(); runner.prepare(changed); auth = { ...target, clientApiKey: 'changed' }; expect(() => runner.start(changed.plan.id)).toThrow('auth changed');
});
it('weights graded kinds by traffic share and excludes errors', () => {
  const p = prepared(), t = { grades: [{ alternative, kind: 'question', outcome: 'match' }, { alternative, kind: 'change', outcome: 'differ' }, { alternative, kind: 'change', outcome: 'error' }] } as ThinkingTest;
  expect(testResults(t, p)[0]).toMatchObject({ matched: 1, graded: 2, errors: 1, weightedMatchShare: 0.8 });
});
const dir = mkdtempSync(path.join(tmpdir(), 'thinking-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it('persists latest results across restarts and removes them with activity history', () => {
  const config = { activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'absent'), databaseKey: 'ab'.repeat(32), retentionDays: 30 };
  let log = new ActivityLog(config);
  const test = { id: 'one', setting, state: 'complete', grades: [] } as unknown as ThinkingTest;
  log.thinkingTestSave(test); log.close(); log = new ActivityLog(config);
  expect(Object.values(log.thinkingTests())[0]?.id).toBe('one');
  log.clear(); expect(log.thinkingTests()).toEqual({}); log.close();
});

it('plans from retained root turns, counts skips and prices cold prompts', () => {
  const log = new ActivityLog({ activityDb: path.join(dir, 'plan.db'), legacyActivityDir: path.join(dir, 'absent'), databaseKey: 'ab'.repeat(32), retentionDays: 30 });
  const at = new Date().toISOString();
  const event = (id: number): ActivityEvent => ({ at, requestId: `r${id}`, traceId: `synthetic-trace-${id}`, selectionId: null, upstreamId: null, source: 'proxy', client: null, provider: setting.provider, model: setting.model, effectiveModel: setting.model, reasoningEffort: setting.effort, authIndex: null, stream: false, failed: false, statusCode: 200, error: null, latencyMs: 1, ttftMs: null, inputTokens: 100, outputTokens: 20, cachedTokens: 200, cacheWriteTokens: 100, sessionId: `root-${id}`, turnKey: 'turn', sessionKind: 'root', movedFrom: null, userAgent: null });
  for (let id = 0; id < 3; id++) { const e = event(id); log.append(e); log.archiveObserve(e); }
  log.archivePolicy({ captureBodies: true, retentionDays: 7, maxBytes: 1024 * 1024 });
  log.archiveIngest({ version: 1, epoch: 'synthetic', dropped: 0, records: [{ id: 'capture', traceId: event(0).traceId!, epoch: 'synthetic', sequence: 1, startedAt: at, method: 'POST', path: '/v1/messages', status: 200, state: 'complete', reason: '', request: JSON.stringify(body), response, requestCut: null, responseCut: null, requestType: 'application/json', responseType: 'application/json', requestEncoding: '', responseEncoding: '' }] });
  const p = log.thinkingTestPrepare({ setting, alternatives: [alternative], turns: 10, query: { from: Date.parse(at) - 1, to: Date.parse(at) + 1, scope: { accounts: null, clients: null } } });
  expect(p.plan).toMatchObject({ eligibleTurns: 3, replayableTurns: 1, sampled: [{ kind: 'question', turns: 1 }, { kind: 'change', turns: 0 }, { kind: 'long', turns: 0 }], skipped: [{ reason: 'request not captured (turn on request capture)', turns: 2 }] });
  expect(p.plan.estimatedCostUsd).toBeGreaterThan(0); expect(p.shares.question).toBe(1); log.close();
});
it('marks judge failures as ungraded errors and cancellation aborts live calls', async () => {
  const p = prepared(); p.samples[0]!.response = JSON.stringify({ content: [{ type: 'text', text: 'original' }] });
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'bad judge JSON' }], usage: { input_tokens: 1, output_tokens: 1 } }))) as unknown as typeof fetch;
  const save = vi.fn(async () => undefined), runner = new ThinkingTestRunner(() => target, save, fetcher);
  runner.prepare(p); runner.start(p.plan.id); await vi.waitFor(() => expect(save).toHaveBeenCalled());
  expect(runner.status(p.plan.id).results[0]).toMatchObject({ graded: 0, errors: 1, weightedMatchShare: null });
  const hanging = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))) as unknown as typeof fetch;
  const canceled = new ThinkingTestRunner(() => target, save, hanging), q = prepared(); canceled.prepare(q); canceled.start(q.plan.id); await canceled.cancel(q.plan.id);
  expect(canceled.status(q.plan.id)).toMatchObject({ state: 'canceled', done: 1 });
});

it('loads only sampled bodies and replaces invalid candidates within their turn and kind', () => {
  const at = new Date().toISOString();
  // More retained turns than the smallest offered sample, with two candidate requests each.
  const retainedTurns = 30;
  const events = Array.from({ length: retainedTurns }, (_, turn) => [0, 1].map((request) => ({
    at, sessionId: `root-${turn}`, sessionKind: 'root', turnKey: 'one', traceId: `trace-${turn}-${request}`,
    provider: setting.provider, model: setting.model, reasoningEffort: setting.effort,
    inputTokens: 100, outputTokens: 20, cachedTokens: 0, failed: false,
  } as ActivityEvent))).flat();
  const db = { prepare: () => ({ all: () => events.map((event) => ({ event: JSON.stringify(event) })) }) } as unknown as Db;
  const detail = vi.fn(() => ({ state: 'complete', method: 'POST', path: '/v1/messages', format: 'http', request: JSON.stringify(body), response, requestEncoding: '', responseEncoding: '' } as ArchiveDetail));
  const archive = { captureMetadata: vi.fn(() => ({ state: 'complete' as const, method: 'POST', path: '/v1/messages', format: 'http' as const, bytes: 100 })), detail };
  const req = { setting, alternatives: [alternative], turns: 10, query: { from: Date.parse(at), to: Date.parse(at), scope: { accounts: null, clients: null } } };
  const plan = prepareTest(db, archive, req);
  expect(plan.samples).toHaveLength(req.turns);
  expect(detail).toHaveBeenCalledTimes(req.turns);
  expect(plan.plan.replayableTurns).toBe(retainedTurns);
  detail.mockClear();
  let rejectedSession: string | undefined;
  detail.mockImplementation((...args: unknown[]) => {
    const trace = args[0] as string, session = trace.slice(0, trace.lastIndexOf('-'));
    rejectedSession ??= session;
    return { state: 'complete', method: 'POST', path: '/v1/messages', format: 'http', request: session === rejectedSession ? '{' : JSON.stringify(body), response, requestEncoding: '', responseEncoding: '' } as ArchiveDetail;
  });
  const replaced = prepareTest(db, archive, req);
  expect(detail).toHaveBeenCalledTimes(req.turns + 2);
  expect(replaced.samples).toHaveLength(req.turns);
  expect(replaced.plan.replayableTurns).toBe(retainedTurns - 1);
  expect(replaced.plan.skipped).toEqual([{ reason: 'body incomplete', turns: 1 }]);
  detail.mockClear();
  detail.mockImplementation(() => ({ state: 'complete', method: 'POST', path: '/v1/messages', format: 'http', request: detail.mock.calls.length === 1 ? '{' : JSON.stringify(body), response, requestEncoding: '', responseEncoding: '' } as ArchiveDetail));
  const recovered = prepareTest(db, archive, req);
  expect(detail).toHaveBeenCalledTimes(req.turns + 1);
  expect(recovered.plan.replayableTurns).toBe(retainedTurns);
  expect(recovered.plan.skipped).toEqual([]);

});
