import { createHash } from 'node:crypto';
import { constants, zstdCompressSync } from 'node:zlib';
import type { Db } from './activityDb';
import { pieceBytes } from './archivePieces';
import type { ArchiveFactSink } from './archiveStore';
import { CLICKHOUSE_CDC_WIRE, cdcWireContent, type CdcFrameBoundary } from './clickhouseWire';

// Normalized FastCDC: 2 KiB min, 8 KiB normal (14/11-bit masks), 64 KiB max.
export const CDC_MIN_BYTES = 2 * 1024;
export const CDC_AVG_BYTES = 8 * 1024;
export const CDC_MAX_BYTES = 64 * 1024;
const CDC_MASK_S = (1 << 14) - 1;
const CDC_MASK_L = (1 << 11) - 1;
// Keep each capture-chunk fact well under CLICKHOUSE_BATCH_BYTES (8 MiB).
export const CDC_MAX_REFS_PER_FACT = 2_048;
export const CDC_MAX_FRAMES_PER_FACT = 2_048;

const GEAR = new Uint32Array(256);
{
  let s = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    GEAR[i] = s >>> 0;
  }
}

export const CDC_SCHEMA = `
CREATE TABLE IF NOT EXISTS clickhouse_cdc_chunks(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 hash BLOB NOT NULL UNIQUE,
 size INTEGER NOT NULL,
 first_at TEXT NOT NULL,
 bytes BLOB,
 sent INTEGER NOT NULL DEFAULT 0
);
`;

/** Streaming FastCDC chunker; holds at most CDC_MAX_BYTES regardless of body size. */
export class FastCdcChunker {
  private readonly buf = Buffer.allocUnsafe(CDC_MAX_BYTES);
  private len = 0;
  private hash = 0;

  push(data: Buffer, onChunk: (chunk: Buffer) => void): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.len < CDC_MIN_BYTES) {
        const take = Math.min(CDC_MIN_BYTES - this.len, data.length - offset);
        data.copy(this.buf, this.len, offset, offset + take);
        this.len += take;
        offset += take;
        continue;
      }
      while (offset < data.length && this.len < CDC_MAX_BYTES) {
        const b = data[offset++]!;
        this.buf[this.len++] = b;
        this.hash = ((this.hash << 1) + GEAR[b]!) >>> 0;
        const mask = this.len < CDC_AVG_BYTES ? CDC_MASK_S : CDC_MASK_L;
        if ((this.hash & mask) === 0) {
          onChunk(Buffer.from(this.buf.subarray(0, this.len)));
          this.len = 0;
          this.hash = 0;
          break;
        }
      }
      if (this.len === CDC_MAX_BYTES) {
        onChunk(Buffer.from(this.buf.subarray(0, this.len)));
        this.len = 0;
        this.hash = 0;
      }
    }
  }

  finish(onChunk: (chunk: Buffer) => void): void {
    if (this.len > 0) {
      onChunk(Buffer.from(this.buf.subarray(0, this.len)));
      this.len = 0;
      this.hash = 0;
    }
  }
}

export function chunkBytes(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunker = new FastCdcChunker();
  chunker.push(data, (chunk) => out.push(chunk));
  chunker.finish((chunk) => out.push(chunk));
  return out;
}

/** Deduplicates a raw CDC chunk by SHA-256; stores compressed bytes only until acknowledged. */
export function internCdcChunk(db: Db, rawBytes: Buffer, at: string): [number, number] {
  const digest = createHash('sha256').update(rawBytes).digest();
  const existing = db.prepare('SELECT id,sent,bytes IS NOT NULL AS hasBytes FROM clickhouse_cdc_chunks WHERE hash=?')
    .get(digest) as { id: number; sent: number; hasBytes: number } | undefined;
  if (existing) {
    if (!existing.sent && !existing.hasBytes) {
      db.prepare('UPDATE clickhouse_cdc_chunks SET bytes=? WHERE id=?')
        .run(zstdCompressSync(rawBytes, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }), existing.id);
    }
    return [existing.id, rawBytes.length];
  }
  const compressed = zstdCompressSync(rawBytes, { params: { [constants.ZSTD_c_compressionLevel]: 3 } });
  const id = Number(db.prepare('INSERT INTO clickhouse_cdc_chunks(hash,size,first_at,bytes,sent) VALUES(?,?,?,?,0)')
    .run(digest, rawBytes.length, at, compressed).lastInsertRowid);
  return [id, rawBytes.length];
}

type WireChunkRow = {
  piece_id: number | null;
  direction: 'request' | 'response';
  offset: number;
  frame_index: number;
  frame_type: 'text' | 'binary';
  frame_at: string;
  frame_end: number;
};

export interface CdcCaptureMeta {
  entryId: string;
  traceId: string;
  captureId: string;
  epoch: string;
  startedAt: string;
  thread: string;
}

/** Emits coalesced, FastCDC-deduplicated v5 capture-chunk facts for a wire entry. */
export function emitCdcCaptureChunks(db: Db, meta: CdcCaptureMeta, sink?: ArchiveFactSink): number {
  if (!sink) return 0;
  const mode = sink.cdcExportMode?.() ?? 'bodies';
  if (mode === 'off') return 0;
  const includeBodies = mode === 'bodies';
  const totals = includeBodies
    ? null
    : JSON.parse((db.prepare('SELECT detail FROM archive_entries WHERE id=?').get(meta.entryId) as { detail: string }).detail) as { requestBytes?: number; responseBytes?: number };
  let seq = 0;
  for (const direction of ['request', 'response'] as const) {
    const rows = db.prepare(
      'SELECT piece_id,direction,offset,frame_index,frame_type,frame_at,frame_end FROM archive_wire WHERE entry_id=? AND direction=? ORDER BY sequence',
    ).all(meta.entryId, direction) as WireChunkRow[];
    if (!rows.length) continue;

    const frames: CdcFrameBoundary[] = [];
    const openFrames = new Map<number, CdcFrameBoundary>();
    const chunks: [number, number][] = [];
    const chunker = new FastCdcChunker();
    let totalBytes = 0;
    const dirTotalBytes = totals ? (direction === 'request' ? totals.requestBytes ?? 0 : totals.responseBytes ?? 0) : 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      let data: Buffer | null = null;
      const len = includeBodies
        ? (data = row.piece_id === null ? Buffer.alloc(0) : pieceBytes(db, row.piece_id)).length
        : (i + 1 < rows.length ? rows[i + 1]!.offset : dirTotalBytes) - row.offset;
      if (row.frame_index) {
        let frame = openFrames.get(row.frame_index);
        if (!frame) {
          frame = { frame: row.frame_index, type: row.frame_type, at: row.frame_at, offset: row.offset, length: 0, end: false };
          openFrames.set(row.frame_index, frame);
          frames.push(frame);
        }
        frame.length += len;
        if (row.frame_end) frame.end = true;
      }
      if (len) {
        totalBytes += len;
        if (data) chunker.push(data, (chunk) => chunks.push(internCdcChunk(db, chunk, meta.startedAt)));
      }
    }
    if (includeBodies) chunker.finish((chunk) => chunks.push(internCdcChunk(db, chunk, meta.startedAt)));

    // Emit bounded facts for both body-included and metadata-only/empty-frame streams.
    let chunkPos = 0, byteOffset = 0, framePos = 0;
    const emitFact = (rawBytes: number, offset: number, sliceFrames: CdcFrameBoundary[], slice: [number, number][] | null) => {
      seq++;
      sink.append({
        kind: 'capture-chunk', traceId: meta.traceId, at: meta.startedAt, captureState: 'pending',
        record: {
          captureId: meta.captureId, epoch: meta.epoch, sequence: seq, representation: CLICKHOUSE_CDC_WIRE,
          direction, offset, rawBytes, ...(sliceFrames.length ? { frames: sliceFrames } : {}),
        },
        content: slice === null ? null : cdcWireContent(meta.thread, slice),
      });
    };
    if (!includeBodies || !chunks.length) {
      const firstFrames = frames.slice(0, CDC_MAX_FRAMES_PER_FACT);
      framePos = firstFrames.length;
      emitFact(includeBodies ? 0 : totalBytes, 0, firstFrames, includeBodies ? [] : null);
    } else {
      while (chunkPos < chunks.length) {
        const slice = chunks.slice(chunkPos, chunkPos + CDC_MAX_REFS_PER_FACT);
        const sliceBytes = slice.reduce((n, [, len]) => n + len, 0);
        const sliceEnd = byteOffset + sliceBytes;
        const isLast = chunkPos + slice.length >= chunks.length;
        const sliceFrames: CdcFrameBoundary[] = [];
        while (framePos < frames.length && (isLast || frames[framePos]!.offset < sliceEnd) && sliceFrames.length < CDC_MAX_FRAMES_PER_FACT) {
          sliceFrames.push(frames[framePos++]!);
        }
        emitFact(sliceBytes, byteOffset, sliceFrames, slice);
        chunkPos += slice.length;
        byteOffset = sliceEnd;
      }
    }
    while (framePos < frames.length) {
      const sliceFrames = frames.slice(framePos, framePos + CDC_MAX_FRAMES_PER_FACT);
      emitFact(0, includeBodies ? byteOffset : totalBytes, sliceFrames, includeBodies ? [] : null);
      framePos += sliceFrames.length;
    }
  }
  return seq;
}
