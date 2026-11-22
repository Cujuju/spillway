import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DEFAULT_CLICKHOUSE_CONFIG } from '@shared/clickhouse';
import { clickhouseDDL, clickhouseRequest, clickhouseTable, insertClickHouse } from './clickhouseHttp';
import { encodeRawPiece, rawPieceSequence } from './clickhouseWire';

it('reserves a disjoint unsigned namespace for raw piece IDs', () => {
  const namespace = 2n ** 63n;
  expect(rawPieceSequence(1).toString()).toBe('9223372036854775809');
  expect(rawPieceSequence(namespace - 1n).toString()).toBe('18446744073709551615');
  for (const invalid of [0n, -1n, namespace, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => rawPieceSequence(invalid)).toThrow('Invalid local ClickHouse piece ID');
  }
});

it('writes a length-prefixed binary String and exact little-endian UInt64 and DateTime64', () => {
  const at = '1970-01-01T00:00:00.001Z';
  const payload = Buffer.from([0xff, 0x00, 0x80]);
  const row = encodeRawPiece('s', 't', 1, at, payload);
  expect(row.toString('hex')).toBe('017301740100000000000080010000000000000003ff0080');
  const long = Buffer.alloc(128, 0xff);
  const encoded = encodeRawPiece('s', 't', 1, at, long);
  expect(encoded.subarray(20, 22).toString('hex')).toBe('8001');
  expect(encoded.subarray(22)).toEqual(long);
});

const scratchEndpoint = process.env.SPILLWAY_TEST_CLICKHOUSE;
it.runIf(Boolean(scratchEndpoint))('reconstructs documented mixed history byte-for-byte after ClickHouse merges', async () => {
  const endpoint = new URL(scratchEndpoint!);
  expect(endpoint.hostname).toBe('127.0.0.1');
  const config = { ...DEFAULT_CLICKHOUSE_CONFIG, endpoint: endpoint.origin, tablePrefix: 'spillway_test_' + randomUUID().replaceAll('-', '') };
  const signal = AbortSignal.timeout(60_000);
  const query = (sql: string) => clickhouseRequest(config, undefined, sql, signal);
  const pieces = clickhouseTable(config, 'pieces'), facts = clickhouseTable(config, 'facts');
  const created: string[] = [];
  const runSql = async (sql: string) => {
    const url = new URL(endpoint);
    for (const name of ['source', 'trace', 'capture', 'epoch']) url.searchParams.set('param_' + name, name);
    url.searchParams.set('param_s', 'source');
    url.searchParams.set('param_seq', '10');
    url.searchParams.set('wait_end_of_query', '1');
    return fetch(url, { method: 'POST', body: sql, signal });
  };
  const docs = readFileSync(new URL('../../docs/clickhouse-export.md', import.meta.url), 'utf8');
  const sql = docs.match(/^WITH\r?\n  chunks AS \([\s\S]*?FORMAT RowBinary;/m)![0]
    .replaceAll('spillway_facts', facts).replaceAll('spillway_pieces', pieces);
  const legacySql = docs.match(/^SELECT p.seq, arrayStringConcat[\s\S]*?GROUP BY p.seq;/m)![0]
    .replaceAll('spillway_facts', facts).replaceAll('spillway_pieces', pieces);
  const terminalSql = docs.match(/^SELECT capture_state, record_json\r?\n[\s\S]*?ORDER BY seq DESC LIMIT 1;/m)![0]
    .replace('LIMIT 1;', 'LIMIT 1 FORMAT JSONEachRow').replace('spillway_facts', facts);
  const original = Buffer.from([0xff, 0, 0x80]);
  const hash = createHash('sha256').update(original).digest('hex');
  const at = '2026-11-21 00:00:00.123';
  const raw = encodeRawPiece('source', 'thread', 1, at + 'Z', original);
  const b64 = original.toString('base64');
  const base = { source_id: 'source', trace_id: 'trace', thread_id: 'thread', at };
  const capture = { captureId: 'capture', epoch: 'epoch' };
  const chunk = (seq: number, journalSeq: number, direction: string, version: number, id?: number | string, length = original.length, offset = 0) => ({
    ...base, seq, schema_version: version, kind: 'capture-chunk', content_policy: 'included',
    request_pieces: id === undefined ? [] : [{ piece_seq: id, offset, length: version === 3 ? b64.length : length }],
    record_json: JSON.stringify({ ...capture, sequence: journalSeq,
      chunk: { direction, offset: direction === 'response' && id === undefined ? original.length : 0, frame: journalSeq, type: 'binary', at, end: true },
      representation: version === 3 ? 'base64-wire-v2' : 'raw-wire-v1', rawBytes: id === undefined ? 0 : length }),
  });
  const sendFacts = (...rows: object[]) => insertClickHouse(config, undefined, rows.map((row) => JSON.stringify(row) + '\n').join(''), signal);
  try {
    for (const kind of ['pieces', 'facts']) {
      await query(clickhouseDDL(config, kind));
      created.push(clickhouseTable(config, kind));
    }
    await insertClickHouse(config, undefined, JSON.stringify({ source_id: 'source', thread_id: 'thread', seq: 1, at, bytes: b64 }) + '\n', signal, 'pieces');
    await insertClickHouse(config, undefined, raw, signal, 'pieces');
    await insertClickHouse(config, undefined, raw, signal, 'pieces');
    const rawSeq = rawPieceSequence(1).toString();
    await sendFacts(chunk(1, 1, 'request', 3, 1), chunk(2, 2, 'response', 3, 1), chunk(3, 2, 'response', 4, rawSeq),
      chunk(4, 3, 'response', 4),
      { ...base, seq: 5, schema_version: 3, kind: 'capture-end', capture_state: 'complete',
        record_json: JSON.stringify({ ...capture, requestBytes: original.length, responseBytes: original.length,
          requestSha256: hash, responseSha256: hash, frameCount: 3 }) });
    await query('OPTIMIZE TABLE ' + pieces + ' FINAL');
    expect(await query('SELECT count() FROM ' + pieces + ' FINAL')).toBe('2\n');
    await insertClickHouse(config, undefined, JSON.stringify({ source_id: 'source', thread_id: 'thread', seq: 2, at, bytes: 'legacy' }) + '\n', signal, 'pieces');
    await sendFacts({ ...base, seq: 10, schema_version: 2, kind: 'capture', content_policy: 'included',
      request_pieces: [{ piece_seq: 2, offset: 0, length: 6 }], record_json: '{}' });
    const legacy = await runSql(legacySql);
    expect(legacy.ok).toBe(true);
    expect(await legacy.text()).toBe('10\tlegacy\n');
    const response = await runSql(sql);
    const body = Buffer.from(await response.arrayBuffer());
    expect(response.ok).toBe(true);
    expect(response.headers.get('X-ClickHouse-Exception-Code')).toBeNull();
    const observed: { sequence: bigint; direction: string; frame: number; bytes: Buffer }[] = [];
    let pos = 0;
    const readString = () => {
      let size = 0, scale = 1, byte;
      do {
        byte = body.readUInt8(pos++);
        size += (byte & 127) * scale;
        scale *= 128;
      } while (byte >= 128);
      const result = body.subarray(pos, pos + size);
      pos += size;
      return result;
    };
    while (pos < body.length) {
      const sequence = body.readBigUInt64LE(pos); pos += 8;
      const { direction, frame } = JSON.parse(readString().toString()) as { direction: string; frame: number };
      observed.push({ sequence, direction, frame, bytes: readString() });
    }
    expect(observed).toEqual([
      { sequence: 1n, direction: 'request', frame: 1, bytes: original },
      { sequence: 2n, direction: 'response', frame: 2, bytes: original },
      { sequence: 3n, direction: 'response', frame: 3, bytes: Buffer.alloc(0) },
    ]);
    const terminal = await runSql(terminalSql);
    expect(terminal.ok).toBe(true);
    const end = await terminal.json() as { capture_state: string; record_json: string };
    expect(end.capture_state).toBe('complete');
    for (const direction of ['request', 'response']) {
      const bytes = Buffer.concat(observed.filter((row) => row.direction === direction).map((row) => row.bytes));
      expect(bytes.length).toBe(JSON.parse(end.record_json)[direction + 'Bytes']);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(JSON.parse(end.record_json)[direction + 'Sha256']);
    }

    for (const malformed of [
      chunk(6, 2, 'response', 4, rawPieceSequence(9).toString()),
      chunk(7, 2, 'response', 4, 1, b64.length),
      chunk(8, 2, 'response', 4, rawSeq, original.length, 1),
      chunk(9, 2, 'response', 7, rawSeq),
    ]) {
      await sendFacts(malformed);
      const failed = await runSql(sql);
      expect(await failed.text()).toContain('Invalid wire capture chunk');
    }
  } finally {
    for (const table of created.reverse()) await query('DROP TABLE ' + table + ' SYNC');
  }
}, 60_000);
