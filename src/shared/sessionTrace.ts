import type { SessionKind } from './types';
import type { CaptureState } from './archive';
import type { TransportMetadata } from './activityTransport';
import type { TokenCounts } from './modelPrices';

export const TRACE_PAGE_SIZE = 25;
export const TRACE_ATTEMPT_PAGE_SIZE = 50;
export const TRACE_SCAN_LIMIT = 5_000;
export type TraceSource = 'proxy' | 'all';
export interface TraceRange { from?: string; to?: string; source?: TraceSource }
export interface TraceQuery extends TraceRange {
  nodeId?: string; parentSessionId?: string; text?: string;
  sort?: 'cost' | 'failed' | 'recent'; before?: string;
}
export interface TraceAttemptQuery extends TraceRange { nodeId: string; before?: string }
/** No payloads. An archive-only link has no token/cost/account observations. */
export interface TraceAttempt extends Required<TransportMetadata> {
  id: string; at: string; requestId: string; selectionId: string | null; traceId: string | null;
  origin: 'activity' | 'archive'; source: 'proxy' | 'client-log';
  sessionId: string | null; parentSessionId: string | null; sessionKind: SessionKind | null;
  model: string | null; effectiveModel: string | null; reasoningEffort: string | null; provider: string | null; client: string | null;
  authIndex: string | null; movedFrom: string | null;
  failed: boolean | null; statusCode: number | null; latencyMs: number | null; ttftMs: number | null;
  tokens: TokenCounts | null; costUsd: number | null;
  captureState: CaptureState; captureReason: string; compactionEndpoint: boolean;
}
export interface TraceMetrics {
  attempts: number; failed: number; unknownOutcomes: number; proxyAttempts: number; importedAttempts: number;
  usageKnown: number; missingUsage: number; unpriced: number; priced: number;
  /** Subtotals of observed usage only; null when none is known. */
  tokens: number | null; costUsd: number | null;
  accountMoves: number; latencyCount: number; latencySumMs: number; ttftCount: number; ttftSumMs: number;
}
export interface TraceParent {
  sessionId: string; observed: boolean; cycle: boolean;
  kind: 'subagent' | 'fork' | 'compaction' | 'unknown';
}
export interface TraceNode {
  id: string; sessionId: string | null; sessionKind: SessionKind | null; kind: 'session' | 'subagent' | 'unassigned';
  firstAt: string; lastAt: string; metrics: TraceMetrics;
  exchanges: number; attemptsWithoutTrace: number; archiveOnly: number;
  parents: TraceParent[]; parentCount: number; conflictingParents: boolean;
  models: string[]; efforts: string[]; dimensionsTruncated: boolean;
}
export interface TraceCoverage {
  from: string; to: string; source: TraceSource; scanned: number; limit: number; limited: boolean; rejected: number;
}
export interface TracePage { nodes: TraceNode[]; more: boolean; next: string | null; coverage: TraceCoverage }
export interface TraceAttemptPage { attempts: TraceAttempt[]; more: boolean; next: string | null; from: string; to: string }
export const traceNodeId = (a: Pick<TraceAttempt, 'sessionId' | 'traceId' | 'id'>): string =>
  a.sessionId ? `session:${a.sessionId}` : a.traceId ? `trace:${a.traceId}` : `attempt:${a.id}`;
export const isSubagentSession = (id: string): boolean => /^(claude|codex):.+:agent:.+$/.test(id);
