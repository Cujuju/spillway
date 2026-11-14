import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';
// Async zlib runs on the libuv threadpool, keeping up-to-8 MiB batches off the main thread.
const compress = promisify(zstdCompress);
import { CLICKHOUSE_TABLES_MISSING, CLICKHOUSE_TABLES_OUTDATED, validateClickHouseConfig, validateClickHouseCredentials, type ClickHouseConfig, type ClickHouseCredentials } from '@shared/clickhouse';
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const QUERY_TIMEOUT_MS = 15_000, UPLOAD_BYTES_PER_SECOND = 32 * 1024;
export const clickhouseTimeout = (bytes: number): number => QUERY_TIMEOUT_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_SECOND) * 1000;
const SQL_STRING = "'(?:[^'\\\\]|\\\\.|'')*'";
const REPLACING_ENGINE = new RegExp(`^(?:Shared|Replicated)?ReplacingMergeTree(?:\\(\\s*(?:${SQL_STRING}\\s*,\\s*${SQL_STRING}\\s*)?\\))?(?:\\s|$)`);
export const CLICKHOUSE_COLUMNS = { schema_version: 'UInt16', source_id: 'String', source_label: 'LowCardinality(String)', seq: 'UInt64', kind: 'LowCardinality(String)', record_key: 'String', trace_id: 'String', thread_id: 'String', at: "DateTime64(3, 'UTC')", capture_state: 'LowCardinality(String)', content_policy: 'LowCardinality(String)', request_pieces: 'Array(Tuple(piece_seq UInt64, offset UInt32, length UInt32))', response: 'String', frames_json: 'String', record_json: 'String' };
export const CLICKHOUSE_PIECE_COLUMNS = { source_id: 'String', thread_id: 'String', seq: 'UInt64', at: "DateTime64(3, 'UTC')", bytes: 'String' };
/** ClickHouse pretty-prints nested types (newlines, indents), so compare type text without layout whitespace. */
export const sameClickHouseType = (actual: string, expected: string): boolean => {
  const canonical = (type: string) => type.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').replace(/\s?,\s?/g, ', ');
  return canonical(actual) === canonical(expected);
};
export const clickhouseTable =(c: ClickHouseConfig, kind = 'facts'): string => `\`${c.database}\`.\`${c.tablePrefix}_${kind}\``;
export function clickhouseDDL(c: ClickHouseConfig, kind = 'facts'): string {
  const columns = kind === 'facts' ? CLICKHOUSE_COLUMNS : CLICKHOUSE_PIECE_COLUMNS;
  return `CREATE TABLE IF NOT EXISTS ${clickhouseTable(validateClickHouseConfig(c), kind)} (${Object.entries(columns).map(([name, type]) => `${name} ${type}${['response', 'frames_json', 'record_json', 'bytes'].includes(name) ? ' CODEC(ZSTD(3))' : ''}`).join(', ')}) ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(at) ORDER BY (${kind === 'facts' ? 'source_id, at, seq' : 'source_id, thread_id, seq'})`;
}
/** Upgrades schema v1 facts in place: the key column is metadata-only for existing parts. */
export const clickhouseUpgradeDDL = (c: ClickHouseConfig): string => `ALTER TABLE ${clickhouseTable(validateClickHouseConfig(c))} ADD COLUMN IF NOT EXISTS record_key String AFTER kind`;
/** Status-only hints; ClickHouse maps unknown database/table to 404 and auth or grant failures to 401/403. */
export function httpFailureHint(status: number): string {
  if (status === 401 || status === 403) return 'check username, password and grants on the database';
  if (status === 404) return 'database or tables missing: create the database in ClickHouse, then use Create table';
  return 'server or schema failure';
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
    }, body: sql.startsWith('INSERT') ? new Uint8Array(await compress(Buffer.from(sql))) : sql });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`ClickHouse HTTP ${response.status} (${httpFailureHint(response.status)})`); }
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
  let outdated = false;
  for (const kind of ['pieces', 'facts']) {
    const expected = kind === 'facts' ? CLICKHOUSE_COLUMNS : CLICKHOUSE_PIECE_COLUMNS;
    const description = await request(`DESCRIBE TABLE ${clickhouseTable(c, kind)} FORMAT JSON`).catch((e: unknown) => {
      // ClickHouse answers an unknown table or database with 404.
      throw e instanceof Error && e.message.startsWith('ClickHouse HTTP 404') ? new Error(`${CLICKHOUSE_TABLES_MISSING}; Create tables needs an existing database`) : e;
    });
    const engine = await request(`SELECT engine_full,sorting_key,partition_key FROM system.tables WHERE database='${c.database}' AND name='${c.tablePrefix}_${kind}' FORMAT JSON`);
    try {
      const columns = (JSON.parse(description) as { data: { name: string; type: string; default_type?: string }[] }).data;
      const table = (JSON.parse(engine) as { data: { engine_full: string; sorting_key: string; partition_key: string }[] }).data;
      const target = table[0];
      // Schema v1 facts lack only record_key; they pass the other checks and are offered an upgrade.
      const v1 = kind === 'facts' && Array.isArray(columns) && !columns.some((col) => col.name === 'record_key');
      const want = v1 ? Object.fromEntries(Object.entries(expected).filter(([name]) => name !== 'record_key')) : expected;
      if (!Array.isArray(columns) || columns.length !== Object.keys(want).length || !Object.entries(want).every(([name, type]) => columns.some((col) => col.name === name && sameClickHouseType(col.type, type) && !col.default_type)) || table.length !== 1 || !target || !REPLACING_ENGINE.test(target.engine_full.replaceAll('`', '')) || target.sorting_key.replaceAll(/[\s()`]/g, '') !== (kind === 'facts' ? 'source_id,at,seq' : 'source_id,thread_id,seq') || target.partition_key.replaceAll(/[\s`]/g, '') !== 'toYYYYMM(at)') throw new Error('incompatible');
      outdated ||= v1;
    } catch { throw new Error('ClickHouse table does not match schema v2 (columns, engine or sorting key)'); }
  }
  if (outdated) throw new Error(`${CLICKHOUSE_TABLES_OUTDATED}; Upgrade tables adds the record_key column`);
}
export async function insertClickHouse(c: ClickHouseConfig, credentials: ClickHouseCredentials | undefined, payload: string, signal: AbortSignal, kind = 'facts'): Promise<void> {
  const result = await clickhouseRequest(c, credentials, `INSERT INTO ${clickhouseTable(c, kind)} SETTINGS async_insert=1, wait_for_async_insert=1 FORMAT JSONEachRow\n${payload}`, signal);
  if (result.trim()) throw new Error('ClickHouse insert returned an unexpected response; batch retained');
}
