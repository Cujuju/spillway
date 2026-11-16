export type CaptureState = 'unknown' | 'missing' | 'pending' | 'partial' | 'complete' | 'expired';
export interface ArchivePolicy { captureBodies: boolean; retentionDays: number; maxBytes: number }
export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = { captureBodies: false, retentionDays: 7, maxBytes: 100 * 1024 * 1024 };
export const ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
export const CAPTURE_BODY_LIMIT = 8 * 1024 * 1024;
/** Transport chunks bound memory; they never limit the stored transaction size. */
export const CAPTURE_CHUNK_BYTES = 64 * 1024;
export const ARCHIVE_PAGE_SIZE = 50;
export function normalizeArchivePolicy(raw: unknown): ArchivePolicy {
  const r = raw && typeof raw === 'object' ? raw as Partial<ArchivePolicy> : {};
  const bounded = (n: unknown, d: number, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n))) : d;
  return { captureBodies: r.captureBodies === true, retentionDays: bounded(r.retentionDays, 7, 1, 90), maxBytes: bounded(r.maxBytes, DEFAULT_ARCHIVE_POLICY.maxBytes, 1024 * 1024, ARCHIVE_MAX_BYTES) };
}
/** Proxy spool v1: one downstream HTTP exchange; not one upstream attempt. */
export interface CaptureCut { offset: number; omitted: number | null }
export interface CaptureRecord {
  event?: 'start' | 'data' | 'end'; chunk?: CaptureChunk;
  requestBytes?: number; responseBytes?: number; frameCount?: number; requestSha256?: string; responseSha256?: string;
  /** null: side complete. Absent: a proxy before per-side cuts (#134), which kept only the first 256 KiB. */
  requestCut?: CaptureCut | null; responseCut?: CaptureCut | null;
  id: string; traceId: string; epoch: string; sequence: number; startedAt: string;
  method: string; path: string; status: number; state: 'complete' | 'partial' | 'missing' | 'pending'; reason: string;
  request: string; response: string; requestType: string; responseType: string; requestEncoding: string; responseEncoding: string;
  format?: 'http' | 'websocket'; requestDecoded?: boolean; responseDecoded?: boolean; frames?: CaptureFrame[];
}
export interface CaptureChunk { direction: 'request' | 'response'; offset: number; data: string; frame: number; type: '' | 'text' | 'binary'; at: string; end: boolean }
export interface CaptureFrame { index: number; direction: 'request' | 'response'; at: string; type: 'text' | 'binary'; payload: string; truncated: boolean; cut?: CaptureCut }
export interface CapturePage { version: number; epoch: string; dropped: number; error?: string; records: CaptureRecord[] }
export interface ArchiveEntry {
  schemaVersion: 1; captureEpoch: string | null; captureSequence: number | null;
  id: string; traceId: string; at: string; state: CaptureState; reason: string;
  sessionId: string | null; model: string; provider: string; client: string | null;
  method: string; path: string; status: number; bytes: number; captureId: string | null;
}
export interface ArchiveDetail extends ArchiveEntry {
  /** Display decoding is bounded; original bytes remain in the archive and ClickHouse. */
  previewOnly?: boolean;
  requestCut?: CaptureCut | null; responseCut?: CaptureCut | null;
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
  clearPending?: boolean;
  exportWarning?: string | null;
  policy: ArchivePolicy; bytes: number; entries: number; bodies: number; epoch: string | null; sequence: number; dropped: number; gaps: number; restarts: number;
  storedBytes: number; threads: number; overBudgetThreads: number; diffFallbacks: number;
  rejected: number;
}
export const archiveCursor = (entry: Pick<ArchiveEntry, 'at' | 'id'>): string => JSON.stringify([entry.at, entry.id]);
