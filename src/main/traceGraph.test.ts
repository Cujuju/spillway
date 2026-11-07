import { expect, it } from 'vitest';
import type { TraceAttempt } from '@shared/sessionTrace';
import { traceNodes } from './traceGraph';

function attempt(id: string, sessionId: string | null, parentSessionId: string | null = null, patch: Partial<TraceAttempt> = {}): TraceAttempt {
  return { id, at: '2026-11-05T12:00:00.000Z', requestId: id, selectionId: `selection-${id}`, traceId: `trace-${id}`,
    origin: 'activity', source: 'proxy', sessionId, parentSessionId, sessionKind: null, model: 'coding', effectiveModel: 'claude-opus-5-5', reasoningEffort: 'high', provider: 'claude', client: 'Claude Code', authIndex: 'account-a', movedFrom: null,
    failed: false, statusCode: null, latencyMs: 1000, ttftMs: 100, tokens: { inputTokens: 1000, outputTokens: 100, cachedTokens: 500, cacheWriteTokens: 200 }, costUsd: 0.01,
    downstreamTransport: 'http', upstreamTransport: 'http', transportFallbackReason: null,
    captureState: 'missing', captureReason: 'metadata-only', compactionEndpoint: false, ...patch };
}

/** Synthetic review run: parallel workers, retry/account move, late parent, orphan and ambiguous ancestry. */
function fixture(): TraceAttempt[] {
  return [
    attempt('review-fail', 'claude:project:agent:review', 'claude:project', { failed: true, statusCode: 429, traceId: 'review-exchange', selectionId: 'review-selection' }),
    attempt('review-retry', 'claude:project:agent:review', 'claude:project', { authIndex: 'account-b', movedFrom: 'account-a', traceId: 'review-exchange', selectionId: 'review-selection', at: '2026-11-05T12:00:02.000Z' }),
    attempt('implement', 'codex:implementation', 'claude:project', { provider: 'codex', effectiveModel: 'gpt-6.1-sol', downstreamTransport: 'websocket', upstreamTransport: 'websocket+http', transportFallbackReason: 'websocket_dial_failed' }),
    attempt('parent-late', 'claude:project', null, { at: '2026-11-05T11:59:00.000Z' }),
    attempt('orphan', 'codex:orphan', 'codex:not-retained'),
    attempt('ambiguous-a', 'codex:ambiguous', 'claude:project'), attempt('ambiguous-b', 'codex:ambiguous', 'codex:another-parent'),
    attempt('unknown-parent', 'claude:project:agent:unknown'),
    attempt('cycle-a', 'codex:cycle-a', 'codex:cycle-b'), attempt('cycle-b', 'codex:cycle-b', 'codex:cycle-a'),
    attempt('self-cycle', 'codex:self', 'codex:self'),
  ];
}

it('replays and reorders a realistic fixture without inventing links or accumulating subtree usage', () => {
  const all = fixture(), summarize = (a: TraceAttempt[]) => traceNodes(a).sort((a, b) => a.id.localeCompare(b.id));
  expect(summarize([...all, ...all])).toEqual(summarize(all.toReversed()));
  const nodes = traceNodes(all);
  const review = nodes.find((n) => n.sessionId === 'claude:project:agent:review')!;
  expect(review).toMatchObject({ kind: 'subagent', exchanges: 1, parents: [{ sessionId: 'claude:project', observed: true, cycle: false }], metrics: { attempts: 2, costUsd: 0.02, tokens: 3600, accountMoves: 1, latencyCount: 1 } });
  expect(nodes.find((n) => n.sessionId === 'claude:project')?.metrics.attempts).toBe(1);
  expect(nodes.reduce((n, x) => n + x.metrics.attempts, 0)).toBe(all.length);
  expect(nodes.find((n) => n.sessionId === 'codex:implementation')?.parents[0]?.kind).toBe('unknown');
  expect(nodes.find((n) => n.sessionId === 'codex:orphan')?.parents[0]).toMatchObject({ observed: false, cycle: false });
  expect(nodes.find((n) => n.sessionId === 'codex:ambiguous')).toMatchObject({ conflictingParents: true, parentCount: 2 });
  expect(nodes.find((n) => n.sessionId === 'claude:project:agent:unknown')).toMatchObject({ kind: 'subagent', parents: [] });
  for (const id of ['codex:cycle-a', 'codex:cycle-b', 'codex:self']) expect(nodes.find((n) => n.sessionId === id)?.parents[0]?.cycle).toBe(true);
});

it('keeps unassigned exchanges separate, with unknown usage/outcome instead of zero or success', () => {
  const nodes = traceNodes([attempt('archive-a', null, null, { origin: 'archive', traceId: 'full-inbound-a', tokens: null, costUsd: null, failed: null }),
    attempt('archive-b', null, null, { origin: 'archive', traceId: 'full-inbound-b', tokens: null, costUsd: null, failed: null }),
    attempt('historical', null, null, { source: 'client-log', traceId: null, latencyMs: 20, ttftMs: 10 })]);
  expect(nodes).toHaveLength(3);
  expect(nodes[0]).toMatchObject({ kind: 'unassigned', id: 'trace:full-inbound-a', metrics: { missingUsage: 1, costUsd: null, tokens: null, unknownOutcomes: 1 } });
  expect(nodes[2]).toMatchObject({ id: 'attempt:historical', attemptsWithoutTrace: 1, metrics: { importedAttempts: 1, latencyCount: 0, ttftCount: 0 } });
});

it('handles a 5,000-node chain and a closing cycle without recursion or ancestor cost propagation', () => {
  const chain = Array.from({ length: 5_000 }, (_, i) => attempt(`request-${i}`, `codex:chain-${i}`, i ? `codex:chain-${i - 1}` : null));
  const nodes = traceNodes(chain);
  expect(nodes).toHaveLength(5_000); expect(nodes.every((n) => n.metrics.attempts === 1)).toBe(true);
  expect(nodes.every((n) => n.parents.every((p) => !p.cycle))).toBe(true);
  chain[0]!.parentSessionId = 'codex:chain-4999';
  expect(traceNodes(chain).every((n) => n.parents[0]?.cycle)).toBe(true);
});

it('bounds dimension and conflicting-parent output while preserving warning counts', () => {
  const nodes = traceNodes(Array.from({ length: 100 }, (_, i) => attempt(`request-${i}`, 'codex:conflict', `codex:parent-${i}`, { model: `alias-${i}`, reasoningEffort: `effort-${i}` })));
  expect(nodes[0]).toMatchObject({ parentCount: 100, conflictingParents: true, dimensionsTruncated: true });
  expect(nodes[0]?.parents).toHaveLength(50); expect(nodes[0]?.models).toHaveLength(12);
});

it('uses observed node kinds for parent edges and leaves conflicting kinds unknown', () => {
  for (const sessionKind of ['root', 'subagent', 'fork', 'compaction'] as const) {
    const [node] = traceNodes([attempt('a', 'codex:child', sessionKind === 'root' ? null : 'codex:parent', { sessionKind }), attempt('b', 'codex:child')]);
    expect(node!.sessionKind).toBe(sessionKind);
    if (sessionKind !== 'root') expect(node!.parents[0]!.kind).toBe(sessionKind);
  }
  const [node] = traceNodes([attempt('a', 'codex:child', 'codex:parent', { sessionKind: 'fork' }), attempt('b', 'codex:child', 'codex:parent', { sessionKind: 'compaction' })]);
  expect(node!.sessionKind).toBeNull(); expect(node!.parents[0]!.kind).toBe('unknown');
});
