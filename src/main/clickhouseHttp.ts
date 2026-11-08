import { zstdCompressSync } from 'node:zlib';
import { validateClickHouseConfig, validateClickHouseCredentials, type ClickHouseConfig, type ClickHouseCredentials } from '@shared/clickhouse';
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const QUERY_TIMEOUT_MS = 15_000, UPLOAD_BYTES_PER_SECOND = 32 * 1024;
export const clickhouseTimeout = (bytes: number): number => QUERY_TIMEOUT_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_SECOND) * 1000;
const SQL_STRING = "'(?:[^'\\\\]|\\\\.|'')*'";
const REPLACING_ENGINE = new RegExp(`^(?:Shared|Replicated)?ReplacingMergeTree(?:\\(\\s*(?:${SQL_STRING}\\s*,\\s*${SQL_STRING}\\s*)?\\))?(?:\\s|$)`);
export const CLICKHOUSE_COLUMNS = { schema_version: 'UInt16', source_id: 'String', source_label: 'LowCardinality(String)', seq: 'UInt64', kind: 'LowCardinality(String)', trace_id: 'String', thread_id: 'String', at: "DateTime64(3, 'UTC')", capture_state: 'LowCardinality(String)', content_policy: 'LowCardinality(String)', request_pieces: 'Array(Tuple(piece_seq UInt64, offset UInt32, length UInt32))', response: 'String', frames_json: 'String', record_json: 'String' };
export const CLICKHOUSE_PIECE_COLUMNS = { source_id: 'String', thread_id: 'String', seq: 'UInt64', at: "DateTime64(3, 'UTC')", bytes: 'String' };
export const clickhouseTable = (c: ClickHouseConfig, kind = 'facts'): string => `\`${c.database}\`.\`${c.tablePrefix}_${kind}\``;
export function clickhouseDDL(c: ClickHouseConfig, kind = 'facts'): string {
  const columns = kind === 'facts' ? CLICKHOUSE_COLUMNS : CLICKHOUSE_PIECE_COLUMNS;
  return `CREATE TABLE IF NOT EXISTS ${clickhouseTable(validateClickHouseConfig(c), kind)} (${Object.entries(columns).map(([name, type]) => `${name} ${type}${['response', 'frames_json', 'record_json', 'bytes'].includes(name) ? ' CODEC(ZSTD(3))' : ''}`).join(', ')}) ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(at) ORDER BY (${kind === 'facts' ? 'source_id, at, seq' : 'source_id, thread_id, seq'})`;
}
/** Never expose server responses: they can echo passwords, submitted SQL or captured content. */
export async function clickhouseRequest(config: ClickHouseConfig, credentials: ClickHouseCredentials | undefined, sql: string, signal: AbortSignal): Promise<string> {
  const c = validateClickHouseConfig(config);
  if (!c.endpoint) throw new Error('Configure an endpoint first');
  const auth = credentials ? validateClickHouseCredentials(credentials) : { username: 'default', password: '' };
  const endpoint = new URL(c.endpoint); endpoint.searchParams.set('wait_end_of_query', '1');
  try {
    const timeout = sql.startsWith('INSERT') ? clickhouseTimeout(Buffer.byteLength(sql)) : QUERY_TIMEOUT_MS;
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), headers: {
      ...(sql.startsWith('INSERT') ? { 'Content-Encoding': 'zstd' } : {}), 'Content-Type': 'text/plain; charset=utf-8', 'X-ClickHouse-User': auth.username, 'X-ClickHouse-Key': auth.password,
    }, body: sql.startsWith('INSERT') ? new Uint8Array(zstdCompressSync(Buffer.from(sql))) : sql });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`ClickHouse HTTP ${response.status}${response.status === 401 || response.status === 403 ? ' (credentials or permissions)' : ' (server or schema failure)'}`); }
    if (response.headers.get('X-ClickHouse-Exception-Code') && response.headers.get('X-ClickHouse-Exception-Code') !== '0') {
      await response.body?.cancel(); throw new Error('ClickHouse reported a query failure');
    }
    const reader = response.body?.getReader(); let result = '', bytes = 0;
    if (reader) for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT_BYTES) { await reader.cancel(); throw new Error('ClickHouse diagnostic response exceeded limit'); }
      result += Buffer.from(value).toString('utf8');
    }
    return result;
  } catch (e) {
    if (signal.aborted) throw new Error('ClickHouse operation cancelled; delivery may be uncertain');
    if (e instanceof Error && /^ClickHouse (HTTP|reported|diagnostic)/.test(e.message)) throw e;
    throw new Error('ClickHouse connection failed or timed out; check endpoint, TLS and network');
  }
}
export async function checkClickHouseSchema(c: ClickHouseConfig, credentials: ClickHouseCredentials | undefined, signal: AbortSignal): Promise<void> {
  const request = (sql: string) => clickhouseRequest(c, credentials, sql, signal);
  if ((await request('SELECT 1 FORMAT TabSeparated')).trim() !== '1') throw new Error('ClickHouse connection returned an unexpected response');
  for (const kind of ['pieces', 'facts']) {
    const expected = kind === 'facts' ? CLICKHOUSE_COLUMNS : CLICKHOUSE_PIECE_COLUMNS;
    const description = await request(`DESCRIBE TABLE ${clickhouseTable(c, kind)} FORMAT JSON`);
    const engine = await request(`SELECT engine_full,sorting_key,partition_key FROM system.tables WHERE database='${c.database}' AND name='${c.tablePrefix}_${kind}' FORMAT JSON`);
    try {
      const columns = (JSON.parse(description) as { data: { name: string; type: string; default_type?: string }[] }).data;
      const table = (JSON.parse(engine) as { data: { engine_full: string; sorting_key: string; partition_key: string }[] }).data;
      const target = table[0];
      if (!Array.isArray(columns) || columns.length !== Object.keys(expected).length || !Object.entries(expected).every(([name, type]) => columns.some((col) => col.name === name && col.type === type && !col.default_type)) || table.length !== 1 || !target || !REPLACING_ENGINE.test(target.engine_full.replaceAll('`', '')) || target.sorting_key.replaceAll(/[\s()`]/g, '') !== (kind === 'facts' ? 'source_id,at,seq' : 'source_id,thread_id,seq') || target.partition_key.replaceAll(/[\s`]/g, '') !== 'toYYYYMM(at)') throw new Error('incompatible');
    } catch { throw new Error('ClickHouse table does not match archive schema v1 (columns, engine or sorting key)'); }
  }
}
export async function insertClickHouse(c: ClickHouseConfig, credentials: ClickHouseCredentials | undefined, payload: string, signal: AbortSignal, kind = 'facts'): Promise<void> {
  const result = await clickhouseRequest(c, credentials, `INSERT INTO ${clickhouseTable(c, kind)} SETTINGS async_insert=1, wait_for_async_insert=1 FORMAT JSONEachRow\n${payload}`, signal);
  if (result.trim()) throw new Error('ClickHouse insert returned an unexpected response; batch retained');
}
