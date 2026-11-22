import { createHash, randomUUID } from 'node:crypto';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { DEFAULT_CLICKHOUSE_CONFIG } from '../src/shared/clickhouse';
import { clickhouseDDL, clickhouseRequest, clickhouseTable, insertClickHouse } from '../src/main/clickhouseHttp';
import { CLICKHOUSE_BASE64_WIRE, CLICKHOUSE_RAW_WIRE, encodeRawPiece, rawPieceSequence } from '../src/main/clickhouseWire';
import { runHistoryMigration } from './clickhouse-history.mts';

const endpoint = process.env.SPILLWAY_TEST_CLICKHOUSE;
const scratch = it.runIf(Boolean(endpoint));
const SOURCE = 'a'.repeat(32), UNVERIFIED = 'b'.repeat(32);
const AT = '2026-11-30 23:30:00.123', NEXT_MONTH = '2026-12-01 00:00:00.000';
const GZIP = gzipSync(Buffer.from('{"synthetic":true}'));
const BINARY = Buffer.from([0, 255, 128, 7]);
const EMPTY = Buffer.alloc(0);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const thread = (captureId: string) => JSON.stringify(['wire', 'epoch', captureId]);
const refs = (piece_seq: number, length: number) => [{ piece_seq, offset: 0, length }];
const jsonLines = (rows: object[]) => rows.map((row) => JSON.stringify(row) + '\n').join('');

function chunk(captureId: string, seq: number, sequence: number, piece: number, bytes: Buffer, direction = 'request', source_id = SOURCE) {
  return {
    source_id, trace_id: captureId, thread_id: thread(captureId), at: AT, seq, schema_version: 3,
    kind: 'capture-chunk', content_policy: 'included', request_pieces: piece ? refs(piece, bytes.toString('base64').length) : [],
    record_json: JSON.stringify({ epoch: 'epoch', captureId, sequence, representation: CLICKHOUSE_BASE64_WIRE, rawBytes: bytes.length,
      chunk: { direction, frame: sequence, offset: 0, type: 'binary', at: AT, end: true } }),
  };
}

function terminal(captureId: string, seq: number, state: string, request: Buffer, response: Buffer) {
  return {
    source_id: SOURCE, trace_id: captureId, thread_id: thread(captureId), at: AT, seq, schema_version: 3,
    kind: 'capture-end', capture_state: state, record_json: JSON.stringify({
      epoch: 'epoch', captureId, requestBytes: request.length, responseBytes: response.length,
      requestSha256: sha(request), responseSha256: sha(response),
    }),
  };
}

async function withScratch(test: (fixture: Awaited<ReturnType<typeof scratchTables>>) => Promise<void>) {
  const fixture = await scratchTables();
  try { await test(fixture); }
  finally { await fixture.query('DROP DATABASE ' + fixture.config.database + ' SYNC'); }
}

async function scratchTables() {
  const url = new URL(endpoint!);
  expect(url.hostname).toBe('127.0.0.1');
  const config = { ...DEFAULT_CLICKHOUSE_CONFIG, endpoint: url.origin, database: 'history_' + randomUUID().replaceAll('-', ''), tablePrefix: 'source' };
  const signal = AbortSignal.timeout(60_000);
  const query = (sql: string) => clickhouseRequest(config, undefined, sql, signal);
  await query('CREATE DATABASE ' + config.database + ' ENGINE=Atomic');
  try {
    await query(clickhouseDDL(config, 'facts'));
    await query(clickhouseDDL(config, 'pieces'));
  } catch (error) {
    await query('DROP DATABASE ' + config.database + ' SYNC');
    throw error;
  }
  const pieces = clickhouseTable(config, 'pieces'), facts = clickhouseTable(config, 'facts');
  const shadowConfig = { ...config, tablePrefix: 'shadow' };
  const migrate = (...options: string[]) => runHistoryMigration([
    '--endpoint', url.origin, '--database', config.database, '--prefix', 'source', ...options,
  ]);
  const insert = (rows: object[] | Buffer, kind = 'facts') => insertClickHouse(config, undefined, Buffer.isBuffer(rows) ? rows : jsonLines(rows), signal, kind);
  const base64 = (seq: number, captureId: string, bytes: Buffer, source_id = SOURCE) => ({
    seq, thread_id: thread(captureId), at: AT, bytes: bytes.toString('base64'), source_id,
  });
  return { config, query, pieces, facts, shadowConfig, migrate, insert, base64 };
}

async function reconstruct(config: Awaited<ReturnType<typeof scratchTables>>['config'], captureId: string) {
  const docs = await readFile(new URL('../docs/clickhouse-export.md', import.meta.url), 'utf8');
  const sql = docs.match(/^WITH\r?\n  chunks AS \([\s\S]*?FORMAT RowBinary;/m)![0]
    .replaceAll('spillway_facts', clickhouseTable(config, 'facts'))
    .replaceAll('spillway_pieces', clickhouseTable(config, 'pieces'));
  const url = new URL(config.endpoint);
  for (const [name, value] of Object.entries({ source: SOURCE, trace: captureId, capture: captureId, epoch: 'epoch' })) {
    url.searchParams.set('param_' + name, value);
  }
  url.searchParams.set('wait_end_of_query', '1');
  const response = await fetch(url, { method: 'POST', body: sql, signal: AbortSignal.timeout(10_000) });
  expect(response.ok).toBe(true);
  const bytes = Buffer.from(await response.arrayBuffer());
  let position = 0;
  const readString = () => {
    let length = 0, scale = 1;
    for (let byte = 128; byte >= 128; scale *= 128) {
      byte = bytes.readUInt8(position++);
      length += (byte & 127) * scale;
    }
    const slice = bytes.subarray(position, position + length);
    position += length;
    return slice;
  };
  const frames: object[] = [];
  while (position < bytes.length) {
    const sequence = Number(bytes.readBigUInt64LE(position));
    position += 8;
    const { direction, frame } = JSON.parse(readString().toString()) as { direction: string; frame: number };
    const payload = readString();
    frames.push({ sequence, direction, frame, length: payload.length, sha256: sha(payload) });
  }
  return frames;
}

scratch('converts fenced gzip and partial WebSocket history while retaining replayable and legacy pieces', async () => {
  await withScratch(async ({ config, query, pieces, facts, shadowConfig, migrate, insert, base64 }) => {
    await using temp = await mkdtempDisposable(join(tmpdir(), 'spillway-history-test-'));
    const reports = await Promise.all(['8', '4'].map(async (floor) => {
      const file = join(temp.path, floor + '.json');
      await writeFile(file, JSON.stringify({ version: 1, sourceId: SOURCE, firstReplayablePieceSeq: floor }));
      return file;
    }));
    const http = CLICKHOUSE_BASE64_WIRE, ws = 'partial-websocket';
    const reportFlags = reports.flatMap((file) => ['--floor-report', file]);
    const originalPiece = base64(1, http, GZIP);
    await query('SYSTEM STOP MERGES ' + pieces);
    await insert([originalPiece, base64(2, http, BINARY), base64(3, ws, BINARY),
      base64(4, 'boundary', BINARY), base64(1, 'unverified', BINARY, UNVERIFIED)], 'pieces');
    await insert([originalPiece], 'pieces');
    await insert(encodeRawPiece(SOURCE, thread(ws), 3, AT, BINARY), 'pieces');
    expect(await query('SELECT count() FROM ' + pieces)).toBe('7\n');
    await insert([
      chunk(http, 1, 1, 1, GZIP), chunk(http, 2, 2, 2, BINARY, 'response'), terminal(http, 3, 'complete', GZIP, BINARY),
      chunk(ws, 4, 1, 3, BINARY), chunk(ws, 5, 2, 0, EMPTY, 'response'), terminal(ws, 6, 'partial', BINARY, EMPTY),
      chunk('boundary', 7, 1, 4, BINARY), chunk('unverified', 8, 1, 1, BINARY, 'request', UNVERIFIED),
      { source_id: SOURCE, thread_id: 'legacy-thread', trace_id: 'legacy', at: AT, seq: 9, schema_version: 2, kind: 'capture',
        record_key: 'legacy-key', content_policy: 'included', request_pieces: refs(1, originalPiece.bytes.length), record_json: '{}' },
    ]);
    const dryRun = await migrate(...reportFlags);
    expect(dryRun).toEqual({ convertedFacts: '3', newRawPieces: '2', reclaimableBase64Pieces: '2', retiredSources: [], shadowBuilt: false });
    expect((await migrate()).convertedFacts).toBe('0');
    expect((await migrate('--retired-source', UNVERIFIED)).retiredSources).toEqual([UNVERIFIED]);
    expect((await migrate('--retired-source', UNVERIFIED)).convertedFacts).toBe('1');
    await expect(migrate(...reportFlags, '--shadow-prefix', 'shadow')).rejects.toThrow('Stop writers and flush');
    const result = await migrate(...reportFlags, '--shadow-prefix', 'shadow', '--fenced');
    expect(result).toEqual({ ...dryRun, shadowBuilt: true, shadowPrefix: 'shadow' });

    const shadowFacts = clickhouseTable(shadowConfig), shadowPieces = clickhouseTable(shadowConfig, 'pieces');
    expect(await query(`SELECT toString(seq) FROM ${shadowPieces} FINAL WHERE source_id='${SOURCE}' ORDER BY seq`))
      .toBe([1, 4, ...[1, 2, 3].map((seq) => rawPieceSequence(seq))].join('\n') + '\n');
    expect(await query(`SELECT seq, schema_version FROM ${shadowFacts} FINAL ORDER BY seq`))
      .toBe('1\t4\n2\t4\n3\t3\n4\t4\n5\t3\n6\t3\n7\t3\n8\t3\n9\t2\n');
    expect(await query(`SELECT JSONExtractString(record_json,'captureId'), JSONExtractString(record_json,'representation') FROM ${shadowFacts} FINAL WHERE seq=1`))
      .toBe(http + '\t' + CLICKHOUSE_RAW_WIRE + '\n');
    const terminalRows = (table: string) => query(`SELECT capture_state,record_json FROM ${table} FINAL WHERE kind='capture-end' ORDER BY seq`);
    expect(await terminalRows(shadowFacts)).toBe(await terminalRows(facts));
    const frame = (sequence: number, direction: string, bytes: Buffer) =>
      ({ sequence, direction, frame: sequence, length: bytes.length, sha256: sha(bytes) });
    for (const [captureId, expected] of [
      [http, [frame(1, 'request', GZIP), frame(2, 'response', BINARY)]],
      [ws, [frame(1, 'request', BINARY), frame(2, 'response', EMPTY)]],
    ] as const) {
      expect(await reconstruct(config, captureId)).toEqual(expected);
      expect(await reconstruct(shadowConfig, captureId)).toEqual(expected);
    }
    await expect(migrate(...reportFlags, '--shadow-prefix', 'shadow', '--fenced')).rejects.toThrow('Shadow tables already exist');
    expect(await query('SELECT count() FROM ' + pieces)).toBe('7\n');

    const swap = (left: string, right: string) => query(`EXCHANGE TABLES ${left} AND ${right}`);
    await swap(pieces, shadowPieces);
    await swap(facts, shadowFacts);
    expect(await reconstruct(config, http)).toEqual([frame(1, 'request', GZIP), frame(2, 'response', BINARY)]);
    await swap(facts, shadowFacts);
    await swap(pieces, shadowPieces);
    expect(await query('SELECT count() FROM ' + pieces)).toBe('7\n');
  });
}, 60_000);

scratch.each(['divergent retry', 'different partition', 'raw ID collision', 'schema v1'] as const)
('refuses to build shadows for %s', async (conflict) => {
  await withScratch(async ({ config, query, facts, pieces, migrate, insert, base64 }) => {
    const captureId = 'capture';
    const original = base64(1, captureId, BINARY);
    await query('SYSTEM STOP MERGES ' + pieces);
    await insert([original], 'pieces');
    await insert([chunk(captureId, 1, 1, 1, BINARY)]);
    let error = 'Conflicting copies';
    if (conflict === 'divergent retry') {
      await insert([{ ...original, bytes: EMPTY.toString('base64') }], 'pieces');
      expect(await query('SELECT count() FROM ' + pieces + ' FINAL')).toBe('1\n');
    } else if (conflict === 'different partition') {
      await insert([{ ...original, at: NEXT_MONTH }], 'pieces');
    } else if (conflict === 'raw ID collision') {
      await insert(encodeRawPiece(SOURCE, 'unrelated-thread', 1, AT, BINARY), 'pieces');
      error = 'A pre-existing raw piece conflicts';
    } else {
      await query('ALTER TABLE ' + facts + ' DROP COLUMN record_key');
      error = 'Upgrade the source facts table';
    }
    await expect(migrate('--retired-source', SOURCE, '--shadow-prefix', 'shadow', '--fenced')).rejects.toThrow(error);
    expect(await query(`SELECT count() FROM system.tables WHERE database='${config.database}' AND startsWith(name,'shadow_')`)).toBe('0\n');
  });
}, 60_000);
