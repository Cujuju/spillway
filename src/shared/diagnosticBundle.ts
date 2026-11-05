import type { ArchiveDetail } from './archive';
import type { ActivityEvent } from './types';

export const DIAGNOSTIC_LIMITS = { records: 20, attempts: 200, logs: 100, bodyBytes: 256 * 1024, preparedBytes: 8 * 1024 * 1024, previews: 2, previewMs: 5 * 60_000 } as const;
export interface DiagnosticSelection {
  operationId: string;
  traceIds: string[];
  includeBodies: boolean;
  includeSettings: boolean;
  includeLogs: boolean;
  includeMessages: boolean;
  excludedRecords?: number;
}
/** Worker-only snapshot. Never returned directly to the renderer or serialized as a bundle. */
export interface DiagnosticSource {
  detail: ArchiveDetail | null;
  attempts: DiagnosticAttempt[];
  attemptsOmitted: number;
  attemptsUnavailable: number;
}
export type DiagnosticAttempt = Omit<Partial<ActivityEvent>, 'model' | 'provider' | 'failed' | 'stream'> & {
  requestId: string; at: string; model?: string | null; provider?: string | null; failed?: boolean | null; stream?: boolean | null;
  metadataSource?: 'activity' | 'archive-link' | 'unavailable';
};
export interface DiagnosticCounts {
  selected: number; included: number; unavailable: number; partial: number; redacted: number; omitted: number;
  bodiesIncluded: number; bodiesUnavailable: number; bodiesOmitted: number;
}
export interface DiagnosticPreview {
  token: string; expiresAt: string; filename: string; bytes: number; json: string; counts: DiagnosticCounts;
}
export interface DiagnosticSaveResult { state: 'saved' | 'canceled'; path?: string }
export const DIAGNOSTIC_WARNING = 'Metadata uses an explicit allowlist and local identity aliases. Optional bodies and messages have structural and recognizable-secret redaction, but arbitrary prompt secrets cannot all be detected. Inspect the exact JSON before sharing. Capture completeness describes observed downstream bytes, never task success. No files, headers, query strings, auth files or client-log prompts are collected.';
