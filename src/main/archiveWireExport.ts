import { EXPORT_MAX_RECORD_BYTES } from '@shared/archiveExport';
import type { Db } from './activityDb';
import type { WireDetail } from './archiveStreams';
import { pieceBytes } from './archivePieces';

export const WIRE_EXPORT_SCHEMA = 'CREATE TABLE IF NOT EXISTS portable_export_wire(ordinal INTEGER NOT NULL,sequence INTEGER NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(ordinal,sequence))';
export function wireDetail(text: string): WireDetail | null {
  try { const value = JSON.parse(text) as WireDetail | null; return value?.wire === 2 ? value : null; }
  catch { return null; }
}
/** The encrypted snapshot owns copies, so later retention cannot change an approved export. */
export function snapshotWire(db: Db, ordinal: number, detail: WireDetail, availableBytes: number): number {
  let bytes = 0;
  const insert = db.prepare('INSERT INTO portable_export_wire VALUES(?,?,?)');
  let sequence = 0;
  for (;;) {
    const row = db.prepare('SELECT * FROM archive_wire WHERE entry_id=? AND sequence>? ORDER BY sequence LIMIT 1').get(detail.entryId, sequence) as { sequence: number; piece_id: number | null; direction: string; offset: number; frame_index: number; frame_type: string; frame_at: string; frame_end: number } | undefined;
    if (!row) break;
    sequence = row.sequence;
    const data = row.piece_id === null ? '' : pieceBytes(db, row.piece_id).toString('base64');
    const record = JSON.stringify({ type: 'wire-chunk', archiveId: detail.entryId, sequence: row.sequence, direction: row.direction, offset: row.offset, frame: row.frame_index, messageType: row.frame_type, at: row.frame_at, end: Boolean(row.frame_end), data });
    const size = Buffer.byteLength(record);
    if (size > EXPORT_MAX_RECORD_BYTES || bytes + size > availableBytes) throw new Error('Wire export snapshot limit reached. Select fewer captures or use ClickHouse body export.');
    insert.run(ordinal, row.sequence, record); bytes += size;
  }
  return bytes;
}
export function* wireSnapshot(db: Db, ordinal: number): Iterable<{ detail: string }> {
  let sequence = 0;
  for (;;) {
    const row = db.prepare('SELECT sequence,detail FROM portable_export_wire WHERE ordinal=? AND sequence>? ORDER BY sequence LIMIT 1').get(ordinal, sequence) as { sequence: number; detail: string } | undefined;
    if (!row) return;
    sequence = row.sequence; yield row;
  }
}
