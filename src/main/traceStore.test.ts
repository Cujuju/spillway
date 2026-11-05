import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TRACE_ATTEMPT_PAGE_SIZE, TRACE_PAGE_SIZE, TRACE_SCAN_LIMIT, type TraceAttemptQuery, type TraceQuery } from '@shared/sessionTrace';
import type { ActivityEvent } from '@shared/types';
import { ActivityLog } from './activityStore';
import { openActivityDb } from './activityDb';
import { parseActivityEvent } from './sse';

const dirs: string[] = [], logs: ActivityLog[] = [];
afterEach(() => { for (const log of logs.splice(0)) log.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = new Date(Date.now() - 60_000).toISOString();
let sequence = 0;
const event = (patch: Partial<ActivityEvent> = {}): ActivityEvent => ({ ...parseActivityEvent(JSON.stringify({ at,
  request_id: `execution-${++sequence}`, trace_id: `full-inbound-${sequence}`, session_id: 'claude:main',
  provider: 'claude', model: 'claude-opus-5-5', alias: 'coding', reasoning_effort: 'high',
  auth_index: 'account-a', latency_ms: 1100, ttft_ms: 200, input_tokens: 1000, output_tokens: 100, cached_tokens: 500 }))!, ...patch });
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-traces-')); dirs.push(dir);
  const config = { activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 30 };
  const log = new ActivityLog(config); logs.push(log);
  const observe = (e: ActivityEvent) => { const stored = log.append(e); log.archiveObserve(stored ?? e); return e; };
  const edit = (fn: (db: ReturnType<typeof openActivityDb>) => void) => { log.close(); const db = openActivityDb(config.activityDb, config.databaseKey); try { fn(db); } finally { db.close(); } };
  return { log, config, observe, edit };
}
const query: TraceQuery = { from: new Date(Date.parse(at) - 86_400_000).toISOString(), to: new Date(Date.parse(at) + 30_000).toISOString(), sort: 'cost' };

it('counts retries once, keeps own usage separate from parents, and preserves account moves and transport', () => {
  const { log, observe } = setup();
  const parent = observe(event({ sessionId: 'claude:main', traceId: 'full-parent', selectionId: 'selection-parent' }));
  const child = observe(event({ sessionId: 'claude:main:agent:review', parentSessionId: parent.sessionId,
    traceId: 'full-child', selectionId: 'selection-retry', failed: true, statusCode: 429, outputTokens: 0 }));
  observe(event({ sessionId: child.sessionId, parentSessionId: parent.sessionId, traceId: child.traceId,
    selectionId: child.selectionId, authIndex: 'account-b', downstreamTransport: 'websocket', upstreamTransport: 'websocket+http', transportFallbackReason: 'websocket_upgrade_426' }));
  observe(child); observe(parent);
  const page = log.traceQuery(query);
  expect(page.nodes).toHaveLength(2);
  const node = page.nodes.find((n) => n.sessionId === child.sessionId)!;
  expect(node).toMatchObject({ kind: 'subagent', exchanges: 1, parents: [{ sessionId: parent.sessionId, observed: true, cycle: false, kind: 'subagent' }],
    metrics: { attempts: 2, failed: 1, accountMoves: 1, usageKnown: 2, latencyCount: 1, ttftCount: 1 } });
  expect(page.nodes.find((n) => n.sessionId === parent.sessionId)?.metrics.attempts).toBe(1);
  expect(page.nodes.reduce((sum, n) => sum + n.metrics.costUsd!, 0)).toBeCloseTo(log.totalsList().reduce((sum, n) => sum + n.costUsd, 0));
  const attempts = log.traceAttempts({ ...query, nodeId: node.id }).attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts.find((a) => a.authIndex === 'account-b')).toMatchObject({ movedFrom: 'account-a', downstreamTransport: 'websocket', upstreamTransport: 'websocket+http', transportFallbackReason: 'websocket_upgrade_426' });
  expect(JSON.stringify(page)).not.toContain('requestType');
});

it('uses canonical reconciliation for imported/proxy usage in either arrival order and on replay', () => {
  for (const proxyFirst of [false, true]) {
    const { log, observe } = setup();
    const proxy = event({ upstreamId: `response-${sequence}`, model: 'claude-opus-5-5', effectiveModel: null });
    const local = { ...proxy, source: 'client-log' as const, requestId: `client-${sequence}`, traceId: null, authIndex: null, latencyMs: null };
    if (proxyFirst) { observe(proxy); log.importEvents([local, local]); }
    else { log.importEvents([local, local]); observe(proxy); }
    observe(proxy);
    expect(log.traceQuery({ ...query, source: 'all' }).nodes[0]?.metrics).toMatchObject({ attempts: 1, proxyAttempts: 1, importedAttempts: 0 });
    expect(log.traceAttempts({ ...query, source: 'all', nodeId: 'session:claude:main' }).attempts).toHaveLength(1);
  }
});

it('preserves recorded cost, unpriced models, absent transport, and metadata-only client timing', () => {
  const { log } = setup();
  log.importEvents([{ ...event({ source: 'client-log', requestId: 'imported', effectiveModel: null, latencyMs: 999, ttftMs: 999 }), costUsd: 7, uncachedCostUsd: 8 }]);
  log.append(event({ model: 'unpriced-model', effectiveModel: null, sessionId: 'claude:unknown-price' }));
  const nodes = log.traceQuery({ ...query, source: 'all' }).nodes;
  expect(nodes.find((n) => n.sessionId === 'claude:main')?.metrics).toMatchObject({ costUsd: 7, importedAttempts: 1, latencyCount: 0, ttftCount: 0 });
  expect(nodes.find((n) => n.sessionId === 'claude:unknown-price')?.metrics).toMatchObject({ costUsd: null, unpriced: 1 });
  expect(log.traceAttempts({ ...query, source: 'all', nodeId: 'session:claude:main' }).attempts[0]).toMatchObject({ downstreamTransport: null, upstreamTransport: null, latencyMs: null, ttftMs: null, costUsd: 7 });
});

it('normalizes legacy absent cache writes and preserves exact retained-ledger cost independently of missing token fields', () => {
  const { log, observe, edit } = setup();
  observe(event());
  edit((db) => {
    db.exec("UPDATE requests SET event=json_remove(event,'$.cacheWriteTokens')");
    db.exec("UPDATE usage_identities SET event=json_set(event,'$.costUsd',0.42)");
  });
  expect(log.traceQuery(query).nodes[0]?.metrics).toMatchObject({ usageKnown: 1, missingUsage: 0, costUsd: 0.42 });
  expect(log.traceAttempts({ ...query, nodeId: 'session:claude:main' }).attempts[0]?.tokens?.cacheWriteTokens).toBe(0);
  edit((db) => db.exec("UPDATE requests SET event=json_remove(event,'$.inputTokens')"));
  expect(log.traceQuery(query).nodes[0]?.metrics).toMatchObject({ usageKnown: 0, missingUsage: 1, tokens: null, costUsd: 0.42 });
});

it('keeps retained-provenance-only parents navigable without tokens, cost, account, or silent summary attribution', () => {
  const { log, observe, edit } = setup();
  const child = observe(event({ sessionId: 'codex:fork-child', parentSessionId: 'codex:parent', reasoningEffort: 'medium',
    upstreamTransport: 'websocket', failed: false }));
  const parent = observe(event({ sessionId: 'codex:parent', traceId: 'full-archived-parent' }));
  const legacy = observe(event({ sessionId: 'claude:legacy-summary', traceId: 'full-legacy-trace' }));
  edit((db) => {
    // Keep the provenance and legacy fixtures explicit across archive schema additions.
    for (const e of [child, parent]) db.prepare("UPDATE archive_attempts SET detail=json_set(detail,'$.provenance',json(?)) WHERE json_extract(detail,'$.requestId')=?")
      .run(JSON.stringify({ ...e, source: 'proxy' }), e.requestId);
    db.prepare("UPDATE archive_attempts SET detail=json_remove(detail,'$.provenance') WHERE json_extract(detail,'$.requestId')=?").run(legacy.requestId);
    db.exec('DELETE FROM requests');
  });
  const nodes = log.traceQuery(query).nodes;
  const node = nodes.find((n) => n.sessionId === child.sessionId)!;
  expect(node).toMatchObject({ kind: 'session', archiveOnly: 1, parents: [{ sessionId: parent.sessionId, observed: true, kind: 'unknown' }], metrics: { costUsd: null, tokens: null, missingUsage: 1, usageKnown: 0 } });
  expect(nodes.some((n) => n.sessionId === legacy.sessionId)).toBe(false);
  expect(nodes.find((n) => n.id === `trace:${legacy.traceId}`)?.kind).toBe('unassigned');
  const attempts = log.traceAttempts({ ...query, nodeId: node.id }).attempts;
  expect(attempts[0]).toMatchObject({ origin: 'archive', parentSessionId: parent.sessionId, reasoningEffort: 'medium', upstreamTransport: 'websocket', tokens: null, costUsd: null, authIndex: null });
  expect(log.traceQuery({ ...query, parentSessionId: parent.sessionId! }).nodes.map((n) => n.id)).toEqual([node.id]);
});

it('reopens and queries malformed archive links without failing trace indexes or losing valid entries', () => {
  const { log, observe, edit } = setup();
  const bad = observe(event({ sessionId: 'claude:bad-link' }));
  const good = observe(event({ sessionId: 'claude:good-link' }));
  edit((db) => {
    db.exec('DELETE FROM requests');
    db.prepare('UPDATE archive_attempts SET detail=? WHERE trace_id=?').run('{broken', bad.traceId);
    db.exec('DROP INDEX archive_attempt_time; DROP INDEX archive_attempt_session');
  });
  expect(log.traceQuery(query).nodes.map((node) => node.sessionId)).toEqual([good.sessionId]);
  expect(log.traceAttempts({ ...query, nodeId: `session:${bad.sessionId}` }).attempts).toEqual([]);
  edit((db) => expect(db.prepare('SELECT count(*) AS n FROM archive_entries').get()).toEqual({ n: 2 }));
});

it('ignores malformed or non-proxy archive provenance, never borrowing an entry summary parent/session', () => {
  const { log, observe, edit } = setup();
  const a = observe(event());
  edit((db) => {
    db.exec('DELETE FROM requests');
    db.prepare("UPDATE archive_attempts SET detail=json_set(detail,'$.provenance',json(?))").run(JSON.stringify({ source: 'client-log', sessionId: 'invented', parentSessionId: 'invented-parent', failed: 'false' }));
  });
  expect(log.traceQuery(query).nodes[0]).toMatchObject({ id: `trace:${a.traceId}`, sessionId: null, parents: [], metrics: { unknownOutcomes: 1, missingUsage: 1 } });
  expect(log.traceAttempts({ ...query, nodeId: `trace:${a.traceId}` }).attempts).toHaveLength(1);
  edit((db) => db.exec("UPDATE archive_attempts SET identity='invalid-json'"));
  expect(log.traceQuery(query)).toMatchObject({ nodes: [], coverage: { rejected: 1 } });
});

it('keeps unassigned-node attempts consistent with normalized empty/oversized/non-string sessions', () => {
  const { log, observe, edit } = setup();
  const examples = ['', 'x'.repeat(513), 42, '🧪'.repeat(513)];
  const events = examples.map((_, i) => observe(event({ sessionId: `temporary-${i}` })));
  edit((db) => {
    for (let i = 0; i < events.length; i++) db.prepare("UPDATE requests SET event=json_set(event,'$.sessionId',json(?)) WHERE json_extract(event,'$.requestId')=?").run(JSON.stringify(examples[i]), events[i]!.requestId);
  });
  const nodes = log.traceQuery(query).nodes;
  expect(nodes).toHaveLength(examples.length);
  for (const node of nodes) {
    expect(node.kind).toBe('unassigned');
    expect(log.traceAttempts({ ...query, nodeId: node.id }).attempts).toHaveLength(node.metrics.attempts);
  }
  expect(() => log.traceAttempts(undefined as unknown as TraceAttemptQuery)).toThrow('Trace node is required');
  expect(() => log.traceAttempts({} as TraceAttemptQuery)).toThrow('Trace node is required');
});

it('pages stable attempt tuples and ranked nodes after cursor-row deletion, binding cursors to their query', () => {
  const { log, observe, edit } = setup();
  for (let i = 0; i < TRACE_ATTEMPT_PAGE_SIZE + 3; i++) observe(event({ requestId: `req_${String(i).padStart(3, '0')}` }));
  const first = log.traceAttempts({ ...query, nodeId: 'session:claude:main' });
  expect(first.attempts).toHaveLength(TRACE_ATTEMPT_PAGE_SIZE); expect(first.more).toBe(true);
  const last = first.attempts.at(-1)!;
  edit((db) => { db.prepare("DELETE FROM requests WHERE json_extract(event,'$.requestId')=?").run(last.requestId); db.prepare("DELETE FROM archive_attempts WHERE json_extract(detail,'$.requestId')=?").run(last.requestId); });
  const second = log.traceAttempts({ ...query, nodeId: 'session:claude:main', before: first.next! });
  expect(second.attempts).toHaveLength(3);
  expect(new Set([...first.attempts, ...second.attempts].map((a) => a.id)).size).toBe(TRACE_ATTEMPT_PAGE_SIZE + 3);
  expect(() => log.traceAttempts({ ...query, nodeId: 'session:other', before: first.next! })).toThrow('does not match');
  for (let i = 0; i < TRACE_PAGE_SIZE + 2; i++) observe(event({ sessionId: `codex:session-${i}`, inputTokens: i + 1 }));
  const page = log.traceQuery(query);
  const lastNode = page.nodes.at(-1)!;
  edit((db) => {
    db.prepare("DELETE FROM requests WHERE json_extract(event,'$.sessionId')=?").run(lastNode.sessionId);
    // These base archive links have no provenance, so their fallback nodes are unassigned.
    db.prepare('DELETE FROM archive_attempts WHERE trace_id IN (SELECT trace_id FROM archive_entries WHERE session_id=?)').run(lastNode.sessionId);
  });
  const tail = log.traceQuery({ ...query, before: page.next! });
  expect(page.nodes).toHaveLength(TRACE_PAGE_SIZE); expect(tail.nodes.length).toBeGreaterThan(0);
  expect(new Set([...page.nodes, ...tail.nodes].map((n) => n.id)).size).toBe(page.nodes.length + tail.nodes.length);
  expect(() => log.traceQuery({ ...query, sort: 'recent', before: page.next! })).toThrow('does not match');
});

it('binds dates, source and text filters to cursors and preserves a default-range anchor', () => {
  const { log, observe } = setup();
  for (let i = 0; i < TRACE_PAGE_SIZE + 1; i++) observe(event({ sessionId: `codex:filter-${i}` }));
  const first = log.traceQuery({ text: 'filter', sort: 'recent' });
  expect(first.more).toBe(true);
  expect(log.traceQuery({ text: 'filter', sort: 'recent', before: first.next! }).nodes).toHaveLength(1);
  for (const patch of [{ from: new Date(Date.parse(first.coverage.from) + 1000).toISOString() }, { to: new Date(Date.parse(first.coverage.to) + 1000).toISOString() }, { source: 'all' as const }, { text: 'other' }, { parentSessionId: 'codex:parent' }]) {
    expect(() => log.traceQuery({ text: 'filter', sort: 'recent', ...patch, before: first.next! })).toThrow('does not match');
  }
});

it('direct-child filtering retains all own attempts, including observations without parent evidence', () => {
  const { log, observe } = setup();
  observe(event({ sessionId: 'codex:child', parentSessionId: 'codex:parent' }));
  observe(event({ sessionId: 'codex:child', parentSessionId: null }));
  observe(event({ sessionId: 'codex:other', parentSessionId: 'codex:elsewhere' }));
  const page = log.traceQuery({ ...query, parentSessionId: 'codex:parent' });
  expect(page.nodes).toHaveLength(1);
  expect(page.nodes[0]).toMatchObject({ sessionId: 'codex:child', metrics: { attempts: 2, usageKnown: 2 } });
});

it('bounds large reads and returns explicit partial coverage while exact node queries reach outside the sample', () => {
  const { log, edit } = setup();
  log.traceQuery(query);
  edit((db) => db.transaction(() => {
    const stmt = db.prepare('INSERT INTO requests(day,failed,event) VALUES(?,?,?)');
    for (let i = 0; i < TRACE_SCAN_LIMIT + 2; i++) stmt.run(at.slice(0, 10), 0, JSON.stringify(event({ sessionId: `codex:${i}`, at: new Date(Date.parse(at) + i).toISOString() })));
  })());
  expect(log.traceQuery(query)).toMatchObject({ nodes: expect.any(Array), coverage: { limited: true, scanned: TRACE_SCAN_LIMIT } });
  expect(log.traceQuery({ ...query, nodeId: 'session:codex:0' }).nodes[0]?.sessionId).toBe('codex:0');
  expect(() => log.traceQuery({ from: 'bad' })).toThrow('date range');
  expect(() => log.traceQuery({ from: '2020-01-01', to: '2026-01-01' })).toThrow('90 days');
  expect(() => log.traceQuery({ before: '[]' })).toThrow('cursor');
});

it('returns no body text and labels compaction only from the captured endpoint, with capture state intact', () => {
  const { log, observe, edit } = setup();
  const a = observe(event());
  edit((db) => db.prepare("UPDATE archive_entries SET path='/backend-api/codex/responses/compact',status=200,state='partial',detail=? WHERE trace_id=?")
    .run(JSON.stringify({ request: 'private prompt', response: 'private tool call' }), a.traceId));
  const result = log.traceAttempts({ ...query, nodeId: 'session:claude:main' });
  expect(result.attempts[0]).toMatchObject({ compactionEndpoint: true, captureState: 'partial', failed: false });
  expect(JSON.stringify(result)).not.toContain('private');
  log.archiveClear();
  expect(log.traceAttempts({ ...query, nodeId: 'session:claude:main' }).attempts[0]?.captureState).toBe('unknown');
  log.clear(); expect(log.traceQuery(query).nodes).toEqual([]);
});
