import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';

const COLUMNS = { schema_version: 'UInt16', source_id: 'String', id: 'String', revision: 'UInt64', trace_id: 'String', at: 'String', capture_state: 'String', content_policy: 'String', record_json: 'String' };
export interface DemoClickHouseRow { source_id: string; id: string; revision: number; capture_state: string; content_policy: string; record_json: string }
/** Loopback-only synthetic destination; rows models SELECT FINAL, requests retains physical retry duplicates. */
export async function startDemoClickHouse() {
  const requests: { url: string; sql: string; user: string | undefined; key: string | undefined }[] = [];
  const rows = new Map<string, DemoClickHouseRow>();
  const events = new EventEmitter();
  const behavior = { status: 200, body: '', partialRows: -1, disconnect: false, schema: true, delayMs: 0, insertStatus: 200, insertBody: '', insertDisconnect: false, insertDelayMs: 0, engine: 'ReplacingMergeTree(revision) ORDER BY (source_id, id) SETTINGS index_granularity = 8192' };
  const server = createServer((req, res) => {
    void (async () => {
      let sql = '';
      for await (const chunk of req) { sql += chunk.toString(); if (Buffer.byteLength(sql) > 9 * 1024 * 1024) { res.writeHead(413).end(); return; } }
      requests.push({ url: req.url ?? '', sql, user: req.headers['x-clickhouse-user'] as string | undefined, key: req.headers['x-clickhouse-key'] as string | undefined });
      if (sql.startsWith('INSERT')) events.emit('insert');
      const respond = () => {
        if (sql.startsWith('INSERT')) {
          const records = sql.slice(sql.indexOf('\n') + 1).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as DemoClickHouseRow);
          for (const row of behavior.partialRows < 0 ? records : records.slice(0, behavior.partialRows)) {
            const id = `${row.source_id}:${row.id}`, previous = rows.get(id);
            if (!previous || previous.revision <= row.revision) rows.set(id, row);
          }
        }
        if (behavior.disconnect || sql.startsWith('INSERT') && behavior.insertDisconnect) { res.destroy(); return; }
        res.statusCode = sql.startsWith('INSERT') ? behavior.insertStatus : behavior.status;
        const body = sql.startsWith('INSERT') ? behavior.insertBody : behavior.body;
        if (res.statusCode !== 200 || body) { res.end(body); return; }
        if (sql.startsWith('SELECT 1')) res.end('1\n');
        else if (sql.startsWith('DESCRIBE')) res.end(JSON.stringify({ data: behavior.schema ? Object.entries(COLUMNS).map(([name, type]) => ({ name, type, default_type: '' })) : [] }));
        else if (sql.startsWith('SELECT engine_full')) res.end(JSON.stringify({ data: [{ engine_full: behavior.engine, sorting_key: 'source_id, id', partition_key: '' }] }));
        else if (sql.startsWith('CREATE TABLE') || sql.startsWith('INSERT')) res.end('');
        else res.writeHead(400).end('Unsupported demo query');
      };
      const delay = sql.startsWith('INSERT') ? behavior.insertDelayMs || behavior.delayMs : behavior.delayMs;
      if (delay) { const timer = setTimeout(respond, delay); res.on('close', () => clearTimeout(timer)); }
      else respond();
    })().catch(() => { res.writeHead(500).end('Demo query failed'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Demo listener unavailable');
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, rows, behavior, events,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((err) => err ? reject(err) : resolve()); }),
  };
}
