import type { PieceDetail, Range } from './archivePieces';

export const CLICKHOUSE_WIRE_VERSION = 3;
export const CLICKHOUSE_RAW_WIRE_VERSION = 4;
export const CLICKHOUSE_CDC_WIRE_VERSION = 5;
export const CLICKHOUSE_BASE64_WIRE = 'base64-wire-v2';
export const CLICKHOUSE_RAW_WIRE = 'raw-wire-v1';
export const CLICKHOUSE_CDC_WIRE = 'cdc-wire-v1';
export const CDC_PIECE_THREAD = 'cdc-v1';

export type ClickHouseWireVersion = typeof CLICKHOUSE_WIRE_VERSION | typeof CLICKHOUSE_RAW_WIRE_VERSION | typeof CLICKHOUSE_CDC_WIRE_VERSION;
export interface CdcFrameBoundary { frame: number; type: 'text' | 'binary'; at: string; offset: number; length: number; end: boolean }
interface WireContent { wire: 2; thread: string; request: Range[]; exportVersion?: ClickHouseWireVersion }
export interface CdcWireContent { wire: 5; thread: string; chunks: [number, number][] }
export type QueuedPieceContent = PieceDetail | WireContent | CdcWireContent;

export function wireContent(thread: string, version: ClickHouseWireVersion | null, piece: number | null, length: number): WireContent {
  const content: WireContent = { wire: 2, thread, request: piece === null ? [] : [[piece, 0, length]] };
  if (version === CLICKHOUSE_RAW_WIRE_VERSION) content.exportVersion = version;
  return content;
}

export function cdcWireContent(thread: string, chunks: [number, number][]): CdcWireContent {
  return { wire: 5, thread, chunks };
}

export function isWireContent(content: QueuedPieceContent | null): content is WireContent {
  return content !== null && 'wire' in content && content.wire === 2;
}

export function isCdcWireContent(content: QueuedPieceContent | null): content is CdcWireContent {
  return content !== null && 'wire' in content && content.wire === 5;
}

const RAW_PIECE_NAMESPACE = 1n << 63n;
const CDC_PIECE_NAMESPACE = 1n << 62n;
export function rawPieceSequence(id: number | bigint): bigint {
  if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('Invalid local ClickHouse piece ID');
  const local = BigInt(id);
  if (local <= 0n || local >= RAW_PIECE_NAMESPACE) throw new Error('Invalid local ClickHouse piece ID');
  return RAW_PIECE_NAMESPACE | local;
}

export function cdcPieceSequence(id: number | bigint): bigint {
  if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('Invalid local ClickHouse CDC chunk ID');
  const local = BigInt(id);
  if (local <= 0n || local >= CDC_PIECE_NAMESPACE) throw new Error('Invalid local ClickHouse CDC chunk ID');
  return CDC_PIECE_NAMESPACE | local;
}

const VAR_UINT_CONTINUATION = 128;
const INT64_BYTES = 8;
const ZONELESS_CAPTURE_TIME = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/;
function rowBinaryString(bytes: Buffer): Buffer[] {
  const length: number[] = [];
  let remaining = bytes.length;
  while (remaining >= VAR_UINT_CONTINUATION) {
    length.push(remaining % VAR_UINT_CONTINUATION + VAR_UINT_CONTINUATION);
    remaining = Math.floor(remaining / VAR_UINT_CONTINUATION);
  }
  return [Buffer.from([...length, remaining]), bytes];
}

function encodeBinaryPiece(source: string, thread: string, seq: bigint, at: string, bytes: Buffer): Buffer {
  const numbers = Buffer.allocUnsafe(INT64_BYTES * 2);
  numbers.writeBigUInt64LE(seq);
  const utc = ZONELESS_CAPTURE_TIME.test(at) ? at.replace(' ', 'T') + 'Z' : at;
  numbers.writeBigInt64LE(BigInt(Date.parse(utc)), INT64_BYTES);
  return Buffer.concat([...rowBinaryString(Buffer.from(source)), ...rowBinaryString(Buffer.from(thread)), numbers, ...rowBinaryString(bytes)]);
}

export function encodeRawPiece(source: string, thread: string, id: number, at: string, bytes: Buffer): Buffer {
  return encodeBinaryPiece(source, thread, rawPieceSequence(id), at, bytes);
}

export function encodeCdcPiece(source: string, id: number, at: string, bytes: Buffer): Buffer {
  return encodeBinaryPiece(source, CDC_PIECE_THREAD, cdcPieceSequence(id), at, bytes);
}
