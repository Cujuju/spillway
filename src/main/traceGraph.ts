import type { SessionKind } from '@shared/types';
import { promptTokens } from '@shared/modelPrices';
import { isSubagentSession, traceNodeId, type TraceAttempt, type TraceMetrics, type TraceNode } from '@shared/sessionTrace';

const emptyMetrics = (): TraceMetrics => ({ attempts: 0, failed: 0, unknownOutcomes: 0, proxyAttempts: 0, importedAttempts: 0,
  usageKnown: 0, missingUsage: 0, unpriced: 0, priced: 0, tokens: null, costUsd: null,
  accountMoves: 0, latencyCount: 0, latencySumMs: 0, ttftCount: 0, ttftSumMs: 0 });

/** Iterative strongly connected components: linear work, including long chains and cycles. */
function components(parents: Map<string, Set<string>>): Map<string, number> {
  const reverse = new Map<string, string[]>(), seen = new Set<string>(), order: string[] = [];
  for (const [child, ps] of parents) for (const p of ps) {
    if (!reverse.has(p)) reverse.set(p, []);
    reverse.get(p)!.push(child);
  }
  for (const start of parents.keys()) {
    const stack: [string, boolean][] = [[start, false]];
    while (stack.length) {
      const [id, done] = stack.pop()!;
      if (done) { order.push(id); continue; }
      if (seen.has(id)) continue;
      seen.add(id); stack.push([id, true]);
      for (const p of parents.get(id) ?? []) if (!seen.has(p)) stack.push([p, false]);
    }
  }
  const result = new Map<string, number>();
  let group = 0;
  for (const start of order.toReversed()) {
    if (result.has(start)) continue;
    const stack = [start]; group++;
    while (stack.length) {
      const id = stack.pop()!;
      if (result.has(id)) continue;
      result.set(id, group);
      for (const child of reverse.get(id) ?? []) stack.push(child);
    }
  }
  return result;
}

/** Each identity is counted once in exactly one node. Edges never roll usage into another node. */
export function traceNodes(observations: TraceAttempt[]): TraceNode[] {
  const nodes = new Map<string, TraceNode>(), parents = new Map<string, Set<string>>();
  const traces = new Map<string, Set<string>>(), models = new Map<string, Set<string>>(), efforts = new Map<string, Set<string>>();
  const kinds = new Map<string, Set<SessionKind>>();
  const seen = new Set<string>();
  for (const a of observations) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const id = traceNodeId(a);
    let node = nodes.get(id);
    if (!node) {
      node = { id, sessionId: a.sessionId, sessionKind: null, kind: a.sessionId ? isSubagentSession(a.sessionId) ? 'subagent' : 'session' : 'unassigned',
        firstAt: a.at, lastAt: a.at, metrics: emptyMetrics(), exchanges: 0, attemptsWithoutTrace: 0, archiveOnly: 0,
        parents: [], parentCount: 0, conflictingParents: false, models: [], efforts: [], dimensionsTruncated: false };
      kinds.set(id, new Set());
      nodes.set(id, node); traces.set(id, new Set()); models.set(id, new Set()); efforts.set(id, new Set());
    }
    if (a.sessionKind) kinds.get(id)!.add(a.sessionKind);
    node.firstAt = node.firstAt < a.at ? node.firstAt : a.at;
    node.lastAt = node.lastAt > a.at ? node.lastAt : a.at;
    if (a.traceId) traces.get(id)!.add(a.traceId); else node.attemptsWithoutTrace++;
    if (a.model) models.get(id)!.add(a.effectiveModel ? `${a.model} → ${a.effectiveModel}` : a.model);
    if (a.reasoningEffort) efforts.get(id)!.add(a.reasoningEffort);
    if (a.origin === 'archive') node.archiveOnly++;
    if (a.sessionId && a.parentSessionId) {
      if (!parents.has(a.sessionId)) parents.set(a.sessionId, new Set());
      parents.get(a.sessionId)!.add(a.parentSessionId);
    }
    const m = node.metrics;
    m.attempts++; m.failed += a.failed === true ? 1 : 0; m.unknownOutcomes += a.failed === null ? 1 : 0;
    m.proxyAttempts += a.source === 'proxy' ? 1 : 0; m.importedAttempts += a.source === 'client-log' ? 1 : 0;
    m.accountMoves += a.movedFrom ? 1 : 0;
    if (a.tokens) { m.usageKnown++; m.tokens = (m.tokens ?? 0) + promptTokens(a.provider ?? '', a.tokens) + a.tokens.outputTokens; }
    else m.missingUsage++;
    if (a.costUsd !== null) { m.priced++; m.costUsd = (m.costUsd ?? 0) + a.costUsd; }
    else if (a.tokens) m.unpriced++;
    if (a.source === 'proxy' && a.failed === false) {
      if (a.latencyMs !== null && a.latencyMs > 0) { m.latencyCount++; m.latencySumMs += a.latencyMs; }
      if (a.ttftMs !== null && a.ttftMs > 0) { m.ttftCount++; m.ttftSumMs += a.ttftMs; }
    }
  }
  const groups = components(parents);
  for (const node of nodes.values()) {
    const observedKinds = [...kinds.get(node.id)!];
    node.sessionKind = observedKinds.length === 1 ? observedKinds[0]! : null;
    const ps = [...parents.get(node.sessionId ?? '') ?? []].sort();
    node.parentCount = ps.length; node.conflictingParents = ps.length > 1;
    node.parents = ps.slice(0, 50).map((p) => ({ sessionId: p, observed: nodes.has(`session:${p}`),
      cycle: groups.get(p) === groups.get(node.sessionId!), kind: node.sessionKind === 'fork' || node.sessionKind === 'compaction' || node.sessionKind === 'subagent' ? node.sessionKind : node.kind === 'subagent' ? 'subagent' : 'unknown' }));
    node.exchanges = traces.get(node.id)!.size;
    const ms = [...models.get(node.id)!].sort(), es = [...efforts.get(node.id)!].sort();
    node.models = ms.slice(0, 12); node.efforts = es.slice(0, 12); node.dimensionsTruncated = ms.length > 12 || es.length > 12;
  }
  return [...nodes.values()];
}
