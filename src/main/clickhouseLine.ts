import { CLICKHOUSE_BATCH_BYTES, type ClickHouseConfig } from '@shared/clickhouse';
export interface OutboxRow { seq: number; kind: string; trace_id: string; at: string; capture_state: string; record: string; content: string | null }
export const outboxBytes = (row: Omit<OutboxRow, 'seq'>): number => [row.kind, row.trace_id, row.at, row.capture_state, row.record, row.content ?? ''].reduce((n, value) => n + Buffer.byteLength(value), 0);
export function encodeClickHouseLine(row: OutboxRow, config: ClickHouseConfig, source: string, captureBodies: boolean): string {
  const include = config.includeBodies && captureBodies && row.content !== null;
  let policy = include ? 'included' : config.includeBodies ? 'source-unavailable' : 'metadata-only';
  const metadata = JSON.parse(row.record);
  let record = include ? { ...metadata, ...JSON.parse(row.content!) } : metadata;
  const encode = () => JSON.stringify({ schema_version: 2, source_id: source, source_label: config.sourceLabel, seq: row.seq, kind: row.kind, trace_id: row.trace_id, at: new Date(row.at).toISOString().replace('T', ' ').slice(0, -1), capture_state: row.capture_state, content_policy: policy, record_json: JSON.stringify(record) }) + '\n';
  let line = encode();
  if (include && Buffer.byteLength(line) > CLICKHOUSE_BATCH_BYTES) { policy = 'omitted-size-limit'; record = metadata; line = encode(); }
  return line;
}
