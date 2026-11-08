import type { PortableCapture } from './archiveExport';

export const EVAL_LIMITS = { snapshotBytes: 4 * 1024 * 1024, caseBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, cases: 200, revisions: 8, fileBytes: 64 * 1024 * 1024, requestBytes: 256 * 1024, outputBytes: 64 * 1024, responseBytes: 256 * 1024, timeoutMs: 60_000 };
/** Shared bounds for literal assertion counts and value lengths. */
export const EVAL_ASSERTION_LIMITS = { count: 20, valueChars: 4096 } as const;
export type EvalAssertion = { kind: 'contains' | 'not-contains' | 'equals'; value: string };
export interface EvalAnnotation {
  title: string; notes: string; expectedOutcome: string; assertions: EvalAssertion[];
  context: { repository: string; revision: string; workspace: 'unknown' | 'unavailable'; notes: string };
}
export interface EvalCase {
  type: 'eval-case'; schemaVersion: 1; id: string; revision: number; parentRevision: number | null; createdAt: string;
  annotation: EvalAnnotation; capture: PortableCapture;
  provenance: { source: 'local-archive' | 'portable-import'; archiveId: string; importedFrom: string | null };
  missingContext: string[]; taskOutcome: 'unknown';
  portability?: { policy: 'credential-redaction-v1'; protocol: 'omitted' | 'redacted' | 'included'; originalPayloadSha256: string | null; replayFidelity: 'not-guaranteed' };
}
export interface EvalCaseSummary { id: string; revision: number; title: string; createdAt: string; bytes: number }
export interface EvalExportPreview { token: string; jsonl: string; bytes: number; includesBodies: boolean }
export interface EvalReplayPreview {
  id: string; caseId: string; revision: number; supported: boolean; reasons: string[]; mode: 'model-call';
  agentTask: 'unsupported'; destination: string; model: string | null; route: string | null; request: string | null;
  assertions: EvalAssertion[]; expectedOutcome: string; missingContext: string[]; expiresAt: string;
  environment: string; maxOutputTokens: number; timeoutMs: number;
  inputFidelity: string;
}
export interface EvalReplayResult {
  id: string; caseId: string; revision: number; state: 'preview' | 'running' | 'complete' | 'failed' | 'canceled';
  httpStatus: number | null; output: string; error: string | null; taskOutcome: 'unknown';
  comparison: 'pass' | 'fail' | 'not-evaluated'; checks: { assertion: EvalAssertion; passed: boolean }[];
}
