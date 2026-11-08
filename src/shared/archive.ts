export type CaptureState = 'unknown' | 'missing' | 'pending' | 'partial' | 'complete' | 'expired';
export interface ArchivePolicy { captureBodies: boolean; retentionDays: number; maxBytes: number }
export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = { captureBodies: false, retentionDays: 7, maxBytes: 100 * 1024 * 1024 };
export const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
export const CAPTURE_BODY_LIMIT = 256 * 1024;
export const ARCHIVE_PAGE_SIZE = 50;
export function normalizeArchivePolicy(raw: unknown): ArchivePolicy {
  const r = raw && typeof raw === 'object' ? raw as Partial<ArchivePolicy> : {};
  const bounded = (n: unknown, d: number, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n))) : d;
  return { captureBodies: r.captureBodies === true, retentionDays: bounded(r.retentionDays, 7, 1, 90), maxBytes: bounded(r.maxBytes, DEFAULT_ARCHIVE_POLICY.maxBytes, 1024 * 1024, ARCHIVE_MAX_BYTES) };
}
/** Proxy spool v1: one downstream HTTP exchange; not one upstream attempt. */
export interface CaptureRecord {
  id: string; traceId: string; epoch: string; sequence: number; startedAt: string;
  method: string; path: string; status: number; state: 'complete' | 'partial' | 'missing' | 'pending'; reason: string;
  request: string; response: string; requestType: string; responseType: string; requestEncoding: string; responseEncoding: string;
  format?: 'http' | 'websocket'; requestDecoded?: boolean; responseDecoded?: boolean; frames?: CaptureFrame[];
}
export interface CaptureFrame { index: number; direction: 'request' | 'response'; at: string; type: 'text' | 'binary'; payload: string; truncated: boolean }
export interface CapturePage { version: number; epoch: string; dropped: number; records: CaptureRecord[] }
export interface ArchiveEntry {
  schemaVersion: 1; captureEpoch: string | null; captureSequence: number | null;
  id: string; traceId: string; at: string; state: CaptureState; reason: string;
  sessionId: string | null; model: string; provider: string; client: string | null;
  method: string; path: string; status: number; bytes: number; captureId: string | null;
}
export interface ArchiveDetail extends ArchiveEntry {
  request: string; response: string; requestType: string; responseType: string; requestEncoding: string; responseEncoding: string;
  format: 'http' | 'websocket'; requestDecoded: boolean; responseDecoded: boolean; frames: CaptureFrame[];
  attempts: { requestId: string; selectionId: string | null; at: string; provenance?: import('./archiveExport').ArchiveAttemptProvenance }[];
}
export interface ArchiveQuery {
  text?: string; sessionId?: string; provider?: string; model?: string; client?: string; state?: CaptureState;
  from?: string; to?: string; before?: string;
}
export interface ArchivePage { entries: ArchiveEntry[]; more: boolean }
export interface ArchiveStatus {
  exportWarning?: string | null;
  policy: ArchivePolicy; bytes: number; entries: number; bodies: number; epoch: string | null; sequence: number; dropped: number; gaps: number; restarts: number;
  rejected: number;
}
export const archiveCursor = (entry: Pick<ArchiveEntry, 'at' | 'id'>): string => JSON.stringify([entry.at, entry.id]);
