import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { RAW_PIECE_NAMESPACE } from '../src/main/clickhouseWire.ts';
import { historyQueries, pieceConflicts, type HistoryTables } from './clickhouse-history-sql.mts';

const SOURCE_ID = /^[a-f0-9]{32}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i;
const TABLE_KINDS = ['facts', 'pieces'] as const;
const MAX_PREFIX = 63 - '_pieces'.length;
const PLAIN_ENGINE = /^ReplacingMergeTree(?:\(\s*\))?\s+PARTITION BY /;
const MANUAL_PATH = 'See docs/clickhouse-history-migration.md for the manual path.';
const usage = 'node scripts/clickhouse-history.mts --endpoint <origin> --database <name> --prefix <source> [--floor-report <file> ...] [--retired-source <id> ...] [--shadow-prefix <unused-prefix> --fenced]';

interface FloorReport { version: number; sourceId: string; firstReplayablePieceSeq: string }
interface TableInfo { name: string; engine: string; engine_full: string; sorting_key: string; partition_key: string }
type HistoryRequest = (sql: string) => Promise<string>;
const tablesFor = (db: string, prefix: string): HistoryTables => ({
  facts: `\`${db}\`.\`${prefix}_facts\``, pieces: `\`${db}\`.\`${prefix}_pieces\``,
});

function identifier(value: string | undefined, label: string): string {
  if (!value || !IDENTIFIER.test(value)) throw new Error(`Enter a simple ClickHouse ${label}`);
  return value;
}

async function replayFloors(files: string[], retired: string[]): Promise<Map<string, bigint>> {
  const floors = new Map<string, bigint>();
  for (const file of files) {
    let report: FloorReport;
    try { report = JSON.parse(await readFile(file, 'utf8')) as FloorReport; }
    catch { throw new Error('Could not read a replay-floor report'); }
    if (report?.version !== 1 || typeof report.sourceId !== 'string' || !SOURCE_ID.test(report.sourceId)
      || typeof report.firstReplayablePieceSeq !== 'string' || !/^[1-9]\d{0,18}$/.test(report.firstReplayablePieceSeq)) {
      throw new Error('Invalid replay-floor report');
    }
    const floor = BigInt(report.firstReplayablePieceSeq);
    if (floor > RAW_PIECE_NAMESPACE) throw new Error('Replay floor exceeds the SQLite piece ID range');
    const prior = floors.get(report.sourceId);
    floors.set(report.sourceId, prior !== undefined && prior < floor ? prior : floor);
  }
  for (const source of retired) {
    if (!SOURCE_ID.test(source) || floors.has(source)) throw new Error('Retired source IDs must be valid and separate from floor reports');
    floors.set(source, RAW_PIECE_NAMESPACE);
  }
  return floors;
}

function connect(origin: URL, floors: Map<string, bigint>): HistoryRequest {
  const endpoint = new URL(origin.origin);
  const pairs = [...floors].map(([source, floor]) => `'${source}':${floor}`);
  endpoint.searchParams.set('param_floors', '{' + pairs.join(',') + '}');
  endpoint.searchParams.set('wait_end_of_query', '1');
  const headers = {
    'X-ClickHouse-User': process.env.SPILLWAY_CLICKHOUSE_USERNAME ?? 'default',
    'X-ClickHouse-Key': process.env.SPILLWAY_CLICKHOUSE_PASSWORD ?? '',
  };
  return async (sql) => {
    let response: Response;
    try { response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers, body: sql }); }
    catch { throw new Error('Could not connect to ClickHouse'); }
    const exception = response.headers.get('X-ClickHouse-Exception-Code');
    if (!response.ok || (exception && exception !== '0')) {
      await response.body?.cancel();
      throw new Error(`ClickHouse query failed (HTTP ${response.status})`);
    }
    return (await response.text()).trimEnd();
  };
}

async function rows<T>(request: HistoryRequest, sql: string): Promise<T[]> {
  const result = await request(sql + ' FORMAT JSONEachRow');
  try { return result ? result.split('\n').map((row) => JSON.parse(row) as T) : []; }
  catch { throw new Error('ClickHouse returned invalid migration metadata'); }
}

async function checkZero(request: HistoryRequest, sql: string, message: string): Promise<void> {
  if (await request(sql + ' FORMAT TabSeparated') !== '0') throw new Error(message);
}

async function checkSource(request: HistoryRequest, database: string, prefix: string, building: boolean): Promise<void> {
  const source = await rows<TableInfo>(request, `SELECT name,engine,engine_full,sorting_key,partition_key
    FROM system.tables WHERE database='${database}' AND name IN ('${prefix}_facts','${prefix}_pieces')`);
  const normalize = (key: string) => key.replace(/[\s()\x60]/g, '');
  for (const kind of TABLE_KINDS) {
    const table = source.find((row) => row.name === prefix + '_' + kind);
    const sort = kind === 'facts' ? 'source_id,at,seq' : 'source_id,thread_id,seq';
    if (!table || !/^(?:Shared|Replicated)?ReplacingMergeTree$/.test(table.engine)
      || normalize(table.sorting_key) !== sort || normalize(table.partition_key) !== 'toYYYYMMat') {
      throw new Error(`Source ${kind} table does not match the Spillway layout`);
    }
    if (building && (table.engine !== 'ReplacingMergeTree' || !PLAIN_ENGINE.test(table.engine_full))) {
      throw new Error('Automatic shadow builds require plain unversioned ReplacingMergeTree. ' + MANUAL_PATH);
    }
  }
  const v2 = await request(`SELECT count() FROM system.columns WHERE database='${database}'
    AND table='${prefix}_facts' AND name='record_key' AND type='String'`);
  if (v2 !== '1') throw new Error('Upgrade the source facts table to Spillway schema v2 first');
  if (building && await request(`SELECT engine FROM system.databases WHERE name='${database}'`) !== 'Atomic') {
    throw new Error('Shadow cutover requires an Atomic database. ' + MANUAL_PATH);
  }
}

async function shadowDDL(request: HistoryRequest, original: string, shadow: string): Promise<string> {
  const ddl = await request('SHOW CREATE TABLE ' + original + ' FORMAT TabSeparatedRaw');
  const firstLine = ddl.split('\n', 1)[0]!.trimEnd();
  if (firstLine.replaceAll('\x60', '') !== 'CREATE TABLE ' + original.replaceAll('\x60', '')) {
    throw new Error('Could not safely clone source DDL. ' + MANUAL_PATH);
  }
  return 'CREATE TABLE ' + shadow + ddl.slice(firstLine.length);
}

export async function runHistoryMigration(args: string[]) {
  const { values } = parseArgs({ args, options: {
    endpoint: { type: 'string' }, database: { type: 'string' }, prefix: { type: 'string' },
    'shadow-prefix': { type: 'string' }, fenced: { type: 'boolean' },
    'floor-report': { type: 'string', multiple: true }, 'retired-source': { type: 'string', multiple: true },
  } });
  const endpoint = new URL(values.endpoint ?? '');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Enter an HTTP(S) origin without credentials or a path');
  const database = identifier(values.database, 'database');
  const prefix = identifier(values.prefix, 'prefix');
  const shadow = values['shadow-prefix'] === undefined ? undefined : identifier(values['shadow-prefix'], 'shadow prefix');
  if (prefix.length > MAX_PREFIX || (shadow && shadow.length > MAX_PREFIX)) throw new Error('ClickHouse table prefix is too long');
  if (shadow === prefix) throw new Error('Source and shadow prefixes must differ');
  if (shadow && !values.fenced) throw new Error('Stop writers and flush async inserts before building. Then supply --fenced.');
  const retired = values['retired-source'] ?? [];
  const floors = await replayFloors(values['floor-report'] ?? [], retired);
  const request = connect(endpoint, floors);
  const source = tablesFor(database, prefix);
  await checkSource(request, database, prefix, Boolean(shadow));
  const queries = historyQueries(source);
  await checkZero(request, pieceConflicts(source.pieces), 'Conflicting copies of a source piece ID');
  await checkZero(request, queries.invalidFacts, 'An eligible v3 fact has a missing piece, invalid extent, or invalid Base64');
  await checkZero(request, queries.incompatibleRaw, 'A pre-existing raw piece conflicts with its v3 source');
  const [summary] = await rows<{ convertedFacts: string; newRawPieces: string; reclaimableBase64Pieces: string }>(request, queries.summary);
  if (!summary) throw new Error('ClickHouse did not return migration counts');
  const report = { ...summary, retiredSources: retired, shadowBuilt: false };
  if (!shadow) return report;
  if (summary.convertedFacts === '0') return report;

  await checkZero(request, `SELECT count() FROM system.tables WHERE database='${database}'
    AND name IN ('${shadow}_facts','${shadow}_pieces')`, 'Shadow tables already exist');
  const copies = tablesFor(database, shadow);
  const piecesDDL = await shadowDDL(request, source.pieces, copies.pieces);
  const factsDDL = await shadowDDL(request, source.facts, copies.facts);
  await request(piecesDDL);
  await request(factsDDL);
  await request(queries.copyPieces(copies.pieces));
  await request(queries.copyFacts(copies.facts));
  await checkZero(request, queries.verifyPieces(copies.pieces), 'Shadow pieces differ from the verified source conversion');
  await checkZero(request, queries.verifyFacts(copies.facts), 'Shadow facts differ from the verified source conversion');
  return { ...report, shadowBuilt: true, shadowPrefix: shadow };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log(usage);
  else {
    try { console.log(JSON.stringify(await runHistoryMigration(args))); }
    catch (error) {
      const message = error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? usage
        : error instanceof Error ? error.message : 'ClickHouse migration failed';
      console.error(message);
      process.exitCode = 1;
    }
  }
}
