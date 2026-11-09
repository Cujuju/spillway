import type { SessionKind } from './types';
import type { ArchiveDetail, ArchiveEntry, ArchivePolicy, ArchiveQuery, ArchiveStatus, CaptureState } from './archive';
import type { TransportMetadata } from './activityTransport';

export const PORTABLE_ARCHIVE_FORMAT = 'spillway.request-archive';
export const PORTABLE_ARCHIVE_VERSION = 1;
export const EXPORT_MAX_RECORD_BYTES = 32 * 1024 * 1024;
export const EXPORT_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const EXPORT_MAX_RECORDS = 20_000;
export interface ExportLimits { recordBytes: number; snapshotBytes: number; records: number }
export const DEFAULT_EXPORT_LIMITS: ExportLimits = { recordBytes: EXPORT_MAX_RECORD_BYTES, snapshotBytes: EXPORT_MAX_SNAPSHOT_BYTES, records: EXPORT_MAX_RECORDS };
export const EXPORT_PREVIEW_TTL_MS = 15 * 60_000;

export interface ArchiveExportOptions {
  query?: Omit<ArchiveQuery, 'before'>;
  /** Exact stable archive IDs. Intersects query when both are supplied. */
  ids?: string[];
  includeRecordedBodies?: boolean;
}
export interface ArchiveAttemptProvenance extends Required<TransportMetadata> {
  source: 'proxy'; model: string | null; effectiveModel: string | null; reasoningEffort: string | null;
  provider: string | null; client: string | null; sessionId: string | null; parentSessionId: string | null; sessionKind: SessionKind | null;
  failed: boolean | null; statusCode: number | null; latencyMs: number | null; ttftMs: number | null;
}
export type PortableAttempt = Omit<ArchiveDetail['attempts'][number], 'provenance'> & { provenance: ArchiveAttemptProvenance | null };
export type PortablePayloadData = Pick<ArchiveDetail, 'requestCut' | 'responseCut' | 'request' | 'response' | 'requestType' | 'responseType' | 'requestEncoding' | 'responseEncoding' | 'requestDecoded' | 'responseDecoded' | 'format' | 'frames'>;
export interface PortableCapture {
  type: 'capture'; entry: ArchiveEntry; attempts: PortableAttempt[]; attemptsState: 'recorded' | 'malformed';
  payload: { state: 'included' | 'omitted' | 'unavailable' | 'malformed'; reason: string; representation: 'downstream-protocol-v1'; sha256: string | null; data: PortablePayloadData | null };
}
export interface PortableManifest {
  type: 'manifest'; format: typeof PORTABLE_ARCHIVE_FORMAT; version: 1; id: string; createdAt: string; expiresAt: string;
  selection: ArchiveExportOptions; unresolvedIds: string[]; records: number; snapshotBytes: number; captureStates: Record<CaptureState, number>;
  recordingPolicy: ArchivePolicy;
  captureDiagnostics: Pick<ArchiveStatus, 'epoch' | 'sequence' | 'dropped' | 'gaps' | 'restarts' | 'rejected'>;
  boundary: 'observed-downstream-only'; taskOutcome: 'unknown'; rawPayloads: 'included-if-recorded' | 'omitted';
  attemptLimit: 200; attemptCompleteness: 'bounded-recorded-links';
}
export interface PortableTrailer {
  type: 'complete'; records: number; bytesBeforeTrailer: number; sha256: string;
  payloadStates: Record<PortableCapture['payload']['state'], number>;
}
export interface ArchiveExportJob {
  id: string; state: 'preview' | 'writing' | 'finalizing' | 'complete' | 'canceled' | 'failed' | 'expired';
  manifest: PortableManifest; writtenRecords: number; writtenBytes: number; path: string | null; error: string | null; warning: string | null;
}
