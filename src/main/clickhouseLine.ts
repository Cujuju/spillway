import type { ClickHouseConfig } from '@shared/clickhouse';
import { CAPTURE_BODY_LIMIT } from '@shared/archive';
import type { PieceDetail, Range } from './archivePieces';
import type { ResolvedRecord } from './clickhouseRecords';
export const CLICKHOUSE_SCHEMA_VERSION = 2;
// JSONEachRow reads named tuples as objects by default; arrays fail with HTTP 400.
const namedPiece = ([piece_seq, offset, length]: Range) => ({ piece_seq, offset, length });
// Request/response plus frames share a 32 MiB insert cap, including 2x JSON-escape headroom.
export const CLICKHOUSE_SINGLE_FACT_BYTES = CAPTURE_BODY_LIMIT * 4;
export interface OutboxRow { seq: number; kind: string; record_key?: string; trace_id: string; at: string; capture_state: string; record: string; content: string | null; expired?: number; thread_id?: string }
export const outboxBytes = (row: Omit<OutboxRow, 'seq'>): number => [row.kind, row.trace_id, row.at, row.capture_state, row.record, row.content ?? '', row.thread_id ?? ''].reduce((n, value) => n + Buffer.byteLength(value), 0);
export function encodeClickHouseLine(row: OutboxRow, config: ClickHouseConfig, source: string, captureBodies: boolean, resolved?: { response: string; frames: unknown[] }, override?: string): string {
  const include = config.includeBodies && captureBodies && row.content !== null;
  const refs = row.content ? JSON.parse(row.content) as PieceDetail : null;
  let policy = override ?? (row.expired ? 'source-expired' : include ? 'included' : config.includeBodies ? 'source-unavailable' : 'metadata-only');
  const fact = { schema_version: CLICKHOUSE_SCHEMA_VERSION, source_id: source, source_label: config.sourceLabel, seq: row.seq, kind: row.kind, record_key: '', trace_id: row.trace_id, thread_id: row.thread_id ?? refs?.thread ?? '', at: clickhouseTime(row.at), capture_state: row.capture_state, content_policy: policy, request_pieces: include ? refs!.request.map(namedPiece) : [], response: include ? resolved?.response ?? '' : '', frames_json: include ? JSON.stringify(resolved?.frames ?? []) : '', record_json: row.record };
  let line = JSON.stringify(fact) + '\n';
  if (include && Buffer.byteLength(line) > CLICKHOUSE_SINGLE_FACT_BYTES) { policy = 'omitted-size-limit'; line = JSON.stringify({ ...fact, content_policy: policy, request_pieces: [], response: '', frames_json: '' }) + '\n'; }
  return line;
}
// Record times come from stored JSON; an unparsable one falls back to the upload time rather than failing the batch.
const clickhouseTime = (at: string): string => { const t = Date.parse(at); return new Date(Number.isFinite(t) ? t : Date.now()).toISOString().replace('T', ' ').slice(0, -1); };
/** A keyed record (request, total, usage, drift, eval): the newest `seq` per (source_id, kind, record_key) is current. */
export function encodeRecordLine(row: OutboxRow, resolved: ResolvedRecord, config: ClickHouseConfig, source: string): string {
  return JSON.stringify({ schema_version: CLICKHOUSE_SCHEMA_VERSION, source_id: source, source_label: config.sourceLabel, seq: row.seq, kind: row.kind, record_key: row.record_key ?? '', trace_id: resolved.trace, thread_id: '', at: clickhouseTime(resolved.at), capture_state: '', content_policy: resolved.content ? 'included' : 'metadata-only', request_pieces: [], response: '', frames_json: '', record_json: resolved.record }) + '\n';
}
