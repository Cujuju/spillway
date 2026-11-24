import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';

import { zstdDecompressSync } from 'node:zlib';
// DESCRIBE types as ClickHouse 26 prints them: named tuples span lines.
const CLICKHOUSE_COLUMNS = { schema_version: 'UInt16', source_id: 'String', source_label: 'LowCardinality(String)', seq: 'UInt64', kind: 'LowCardinality(String)', record_key: 'String', trace_id: 'String', thread_id: 'String', at: "DateTime64(3, 'UTC')", capture_state: 'LowCardinality(String)', content_policy: 'LowCardinality(String)', request_pieces: 'Array(Tuple(\n    piece_seq UInt64,\n    offset UInt32,\n    length UInt32))', response: 'String', frames_json: 'String', record_json: 'String' };
const CLICKHOUSE_PIECE_COLUMNS = { source_id: 'String', thread_id: 'String', seq: 'UInt64', at: "DateTime64(3, 'UTC')", bytes: 'String' };
export interface DemoClickHouseRow { source_id: string; seq: number; kind: string; at: string; record_key: string; trace_id?: string; record_json: string; capture_state?: string; content_policy?: string; schema_version?: number; request_pieces?: { piece_seq: string | number; offset: number; length: number }[] }
interface DemoClickHousePiece { source_id: string; thread_id: string; seq: number | string; at: string; bytes: string | Buffer }

function readRawPieces(body: Buffer): DemoClickHousePiece[] {
  const pieces: DemoClickHousePiece[] = [];
  let offset = 0;
  const takeString = () => {
    let length = 0, scale = 1;
    for (;;) {
      const byte = body.readUInt8(offset++);
      length += (byte & 127) * scale;
      if (length > body.length) throw new Error('Invalid RowBinary string length');
      if (byte < 128) break;
      scale *= 128;
      if (scale > body.length) throw new Error('Invalid RowBinary string length');
    }
    const end = offset + length;
    if (end > body.length) throw new Error('Truncated RowBinary string');
    const data = body.subarray(offset, end);
    offset = end;
    return data;
  };
  while (offset < body.length) {
    const source_id = takeString().toString(), thread_id = takeString().toString();
    const seq = body.readBigUInt64LE(offset).toString(); offset += 8;
    const at = new Date(Number(body.readBigInt64LE(offset))).toISOString(); offset += 8;
    pieces.push({ source_id, thread_id, seq, at, bytes: takeString() });
  }
  return pieces;
}
const asLines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
// Exported `at` is UTC text without a zone suffix; the column is DateTime64(3, 'UTC').
const atMs = (at: string) => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);

function selectActivity(sql: string, params: URLSearchParams, facts: DemoClickHouseRow[]): string | undefined {
  const group = sql.startsWith("SELECT formatDateTime(at, '%F', {zone:String}) AS day,") && sql.includes('GROUP BY day, authIndex, client, source, reasoningEffort, failed');
  const records = sql.startsWith('SELECT record_json FROM (\n') && sql.includes('ORDER BY at DESC, seq DESC, source_id, record_key');
  const exists = /^SELECT 1 AS present FROM `\w+`\.`\w+_facts`\n/.test(sql);
  const kind = params.get('param_kind');
  const from = Number(params.get('param_from')), to = Number(params.get('param_to')), limit = Number(params.get('param_limit'));
  if (!sql.includes('WHERE kind = {kind:String} AND at >= fromUnixTimestamp64Milli({from:Int64}) AND at < fromUnixTimestamp64Milli({to:Int64})')
    || !sql.endsWith('LIMIT {limit:UInt64} FORMAT JSONEachRow') || !params.has('param_from') || !params.has('param_to')
    || !Number.isFinite(from) || !Number.isFinite(to) || !Number.isSafeInteger(limit) || limit < 1
    || (kind !== 'request' && !(records && kind === 'total'))) return;
  if (!exists && (!(group || records) || !sql.includes(`ORDER BY seq DESC LIMIT 1 BY source_id, record_key${kind === 'request' ? ', at' : ''}\n`))) return;
  const matching = facts.filter((row) => {
    const at = atMs(row.at);
    return row.kind === kind && at >= from && at < to;
  });
  if (exists) return asLines(matching.length ? [{ present: 1 }] : []);
  const newest = new Map<string, DemoClickHouseRow>();
  for (const row of matching) {
    const key = JSON.stringify([row.source_id, row.record_key, kind === 'request' ? atMs(row.at) : 0]);
    const previous = newest.get(key);
    if (!previous || row.seq > previous.seq) newest.set(key, row);
  }
  if (records) {
    const sorted = [...newest.values()].sort((a, b) => atMs(b.at) - atMs(a.at) || b.seq - a.seq
      || a.source_id.localeCompare(b.source_id) || a.record_key.localeCompare(b.record_key));
    return asLines(sorted.slice(0, limit).map(({ record_json }) => ({ record_json })));
  }
  const zone = params.get('param_zone');
  if (!zone) return;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const counts = new Map<string, { day: string; authIndex: string; client: string; source: string; reasoningEffort: string; failed: number; requests: number }>();
  for (const row of newest.values()) {
    const event = JSON.parse(row.record_json) as Record<string, unknown>;
    const stringField = (key: string) => typeof event[key] === 'string' ? event[key] : '';
    const day = format.format(new Date(atMs(row.at)));
    const group = { day, authIndex: stringField('authIndex'), client: stringField('client'), source: stringField('source'),
      reasoningEffort: stringField('reasoningEffort'), failed: Number(event.failed === true) };
    const key = JSON.stringify(group);
    const current = counts.get(key) ?? { ...group, requests: 0 };
    current.requests++;
    counts.set(key, current);
  }
  return asLines([...counts.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit)
    .map((row) => ({ ...row, requests: String(row.requests) })));
}

/** Loopback-only synthetic destination; rows models SELECT FINAL, requests retains physical retry duplicates. */
export async function startDemoClickHouse() {
  const requests: { url: string; sql: string; user: string | undefined; key: string | undefined; contentType?: string; encoding?: string }[] = [];
  const pieces = new Map<string, DemoClickHousePiece>();
  const rows = new Map<string, DemoClickHouseRow>();
  const facts: DemoClickHouseRow[] = [];
  const addRows = (records: DemoClickHouseRow[]) => {
    for (const row of records) { facts.push(row); rows.set(`${row.source_id}:${row.seq}`, row); }
  };
  const events = new EventEmitter();
  const behavior = { schemaVersion: 2, sorting: 'source_id, at, seq', partition: 'toYYYYMM(at)', status: 200, body: '', partialRows: -1, disconnect: false, schema: true, delayMs: 0, insertStatus: 200, insertBody: '', insertExceptionCode: '', insertDisconnect: false, insertDelayMs: 0, engine: 'ReplacingMergeTree PARTITION BY toYYYYMM(at) ORDER BY (source_id, at, seq) SETTINGS index_granularity = 8192' };
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { chunks.push(Buffer.from(chunk)); size += chunk.length; if (size > 9 * 1024 * 1024) { res.writeHead(413).end(); return; } }
      const raw = Buffer.concat(chunks);
      const encoding = req.headers['content-encoding'], contentType = req.headers['content-type'];
      const body = encoding === 'zstd' ? zstdDecompressSync(raw) : raw;
      const params = new URL(req.url ?? '', 'http://127.0.0.1').searchParams;
      const binaryQuery = params.get('query');
      const sql = binaryQuery ?? body.toString();
      const isPieces = /_pieces[`']/.test(sql);
      const binary = isPieces && Boolean(binaryQuery) && sql.endsWith(' FORMAT RowBinary');
      requests.push({ url: req.url ?? '', sql, user: req.headers['x-clickhouse-user'] as string | undefined, key: req.headers['x-clickhouse-key'] as string | undefined, contentType, encoding });
      if (sql.startsWith('INSERT')) events.emit('insert', sql);
      const respond = () => {
        if (sql.startsWith('INSERT')) {
          const take = <T,>(rows: T[]) => behavior.partialRows < 0 ? rows : rows.slice(0, behavior.partialRows);
          if (binary) {
            if (contentType !== 'application/octet-stream') { res.writeHead(415).end(); return; }
            for (const row of take(readRawPieces(body))) pieces.set(`${row.source_id}:${row.seq}`, row);
          } else {
            const lines = sql.slice(sql.indexOf('\n') + 1).trim().split('\n').filter(Boolean);
            if (isPieces) {
              const records = lines.map((line) => JSON.parse(line) as DemoClickHousePiece);
              for (const row of take(records)) pieces.set(`${row.source_id}:${row.seq}`, row);
            } else {
              const records = lines.map((line) => JSON.parse(line) as DemoClickHouseRow);
              if (records.some((r) => r.request_pieces?.some(Array.isArray))) { res.writeHead(400).end('Cannot parse input: expected \'{\''); return; }
              addRows(take(records));
            }
          }
        }
        if (behavior.disconnect || sql.startsWith('INSERT') && behavior.insertDisconnect) { res.destroy(); return; }
        res.statusCode = sql.startsWith('INSERT') ? behavior.insertStatus : behavior.status;
        if (sql.startsWith('INSERT') && behavior.insertExceptionCode) res.setHeader('X-ClickHouse-Exception-Code', behavior.insertExceptionCode);
        const reply = sql.startsWith('INSERT') ? behavior.insertBody : behavior.body;
        if (res.statusCode !== 200 || reply || sql.startsWith('INSERT') && behavior.insertExceptionCode) { res.end(reply); return; }
        if (sql === 'SELECT 1 FORMAT TabSeparated') res.end('1\n');
        else if (sql.startsWith('DESCRIBE')) res.end(JSON.stringify({ data: behavior.schema ? Object.entries(isPieces ? CLICKHOUSE_PIECE_COLUMNS : CLICKHOUSE_COLUMNS).filter(([name]) => behavior.schemaVersion > 1 || name !== 'record_key').map(([name, type]) => ({ name, type, default_type: '' })) : [] }));
        else if (sql.startsWith('SELECT engine_full')) res.end(JSON.stringify({ data: [{ engine_full: behavior.engine, sorting_key: isPieces && behavior.sorting.replaceAll(' ', '') === 'source_id,at,seq' ? 'source_id,thread_id,seq' : behavior.sorting, partition_key: behavior.partition }] }));
        else if (sql.startsWith('CREATE TABLE') || sql.startsWith('ALTER TABLE') || sql.startsWith('INSERT')) res.end('');
        else {
          const output = selectActivity(sql, params, facts);
          if (output === undefined) res.writeHead(400).end('Unsupported demo query');
          else res.end(output);
        }
      };
      const delay = sql.startsWith('INSERT') ? behavior.insertDelayMs || behavior.delayMs : behavior.delayMs;
      if (delay) { const timer = setTimeout(respond, delay); res.on('close', () => clearTimeout(timer)); }
      else respond();
    })().catch(() => { res.writeHead(500).end('Demo query failed'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Demo listener unavailable');
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, rows, pieces, behavior, events, addRows,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((err) => err ? reject(err) : resolve()); }),
  };
}
