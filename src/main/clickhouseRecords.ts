import { validateClickHouseConfig, type ClickHouseConfig, type ClickHouseStoreName } from '@shared/clickhouse';
import type { Db } from './activityDb';

/** Keyed records: triggers queue a reference on every insert or update; delivery reads the current row. `{r}` is the row alias. */
interface RecordSpec {
  kind: string; store: ClickHouseStoreName; table: string; key: string; at: string; trace: string; record: string;
  /** Record sent when captured content is included; `record` is the metadata-only form. */
  withContent?: string;
}
const jsonOrText = (column: string) => `CASE WHEN json_valid(${column}) THEN json(${column}) ELSE ${column} END`;
// Totals carry an hour start (epoch ms) or, for day totals and legacy rows, only a local day.
const TOTAL_AT = "coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', json_extract({r}.total,'$.start')/1000.0,'unixepoch'), json_extract({r}.total,'$.day')||'T00:00:00.000Z')";
export const RECORD_SPECS: readonly RecordSpec[] = [
  { kind: 'request', store: 'requests', table: 'requests', key: 'CAST({r}.id AS TEXT)', at: "json_extract({r}.event,'$.at')", trace: "coalesce(json_extract({r}.event,'$.traceId'),'')", record: '{r}.event' },
  { kind: 'request-settings', store: 'requests', table: 'request_settings', key: '{r}.hash', at: '{r}.first_at', trace: "''", record: `json_object('hash',{r}.hash,'firstAt',{r}.first_at,'settings',${jsonOrText('{r}.settings')})` },
  { kind: 'total', store: 'totals', table: 'activity_totals', key: '{r}.key', at: TOTAL_AT, trace: "''", record: `json_object('key',{r}.key,'total',json({r}.total))` },
  { kind: 'canary', store: 'drift', table: 'canary_results', key: '{r}.id', at: "json_extract({r}.result,'$.at')", trace: "''", record: '{r}.result' },
  { kind: 'thinking-test', store: 'evals', table: 'thinking_tests', key: '{r}.setting_key', at: "json_extract({r}.test,'$.startedAt')", trace: "''", record: `json_object('settingKey',{r}.setting_key,'test',json({r}.test))` },
  { kind: 'eval-case', store: 'evals', table: 'eval_cases', key: "{r}.id||':'||{r}.revision", at: '{r}.created_at', trace: "''", record: "json_remove({r}.snapshot,'$.capture')", withContent: '{r}.snapshot' },
  { kind: 'usage-sample', store: 'usage', table: 'clickhouse_usage', key: '{r}.key', at: '{r}.at', trace: "''", record: '{r}.record' },
  { kind: 'usage-window', store: 'usage', table: 'clickhouse_usage', key: '{r}.key', at: '{r}.at', trace: "''", record: '{r}.record' },
  { kind: 'usage-span', store: 'usage', table: 'clickhouse_usage', key: '{r}.key', at: '{r}.at', trace: "''", record: '{r}.record' },
];
export const recordSpec = (kind: string): RecordSpec | undefined => RECORD_SPECS.find((s) => s.kind === kind);
const sql = (expr: string, alias: string) => expr.replaceAll('{r}', alias);
// The mirror table holds several usage kinds; others hold one kind per table.
const kindFilter = (spec: RecordSpec, alias: string) => spec.table === 'clickhouse_usage' ? `${alias}.kind='${spec.kind}'` : '1';
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
/** Outbox columns for a record reference; the payload is read at delivery. */
const reference = (spec: RecordSpec, alias: string) => {
  const key = sql(spec.key, alias), at = `coalesce(${sql(spec.at, alias)},${NOW})`;
  return `'${spec.kind}',${key},'',${at},'','',NULL,length(CAST('${spec.kind}' AS BLOB))+length(CAST(${key} AS BLOB))+length(CAST(${at} AS BLOB))`;
};
const OUTBOX_COLUMNS = 'kind,record_key,trace_id,at,capture_state,record,content,bytes';

/** Usage history lives in main-process files; this mirror gives it the same trigger path. */
const USAGE_TABLE = 'CREATE TABLE IF NOT EXISTS clickhouse_usage (kind TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(kind,key))';
const ALL_CURSORS = JSON.stringify(Object.fromEntries(RECORD_SPECS.map((s) => [s.kind, 0])));

/** Adds record columns to v1 outbox state and (re)creates triggers; runs after every source table exists. */
export function installClickHouseRecords(db: Db): void {
  db.exec(USAGE_TABLE);
  const has = (table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  if (!has('clickhouse_outbox', 'record_key')) db.exec("ALTER TABLE clickhouse_outbox ADD COLUMN record_key TEXT NOT NULL DEFAULT ''");
  // Installs exporting before records existed backfill them once.
  if (!has('clickhouse_export', 'record_cursors')) db.exec(`ALTER TABLE clickhouse_export ADD COLUMN record_cursors TEXT NOT NULL DEFAULT '${ALL_CURSORS}'`);
  db.exec('CREATE INDEX IF NOT EXISTS clickhouse_outbox_record ON clickhouse_outbox(kind,record_key)');
  syncRecordTriggers(db, validateClickHouseConfig(JSON.parse((db.prepare('SELECT config FROM clickhouse_export').get() as { config: string }).config)));
}

/** Triggers exist only for exporting stores, so writes cost nothing extra while export is off. */
export function syncRecordTriggers(db: Db, config: ClickHouseConfig): void {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'clickhouse_record_*'").all() as { name: string }[]) db.exec(`DROP TRIGGER ${row.name}`);
  if (!config.enabled) return;
  for (const spec of RECORD_SPECS) if (config.stores[spec.store]) for (const op of ['INSERT', 'UPDATE']) {
    const name = `clickhouse_record_${spec.kind.replaceAll('-', '_')}_${op.toLowerCase()}`;
    db.exec(`CREATE TRIGGER ${name} AFTER ${op} ON ${spec.table} WHEN ${kindFilter(spec, 'NEW')} BEGIN
 DELETE FROM clickhouse_outbox WHERE kind='${spec.kind}' AND record_key=${sql(spec.key, 'NEW')};
 INSERT INTO clickhouse_outbox(${OUTBOX_COLUMNS}) VALUES(${reference(spec, 'NEW')});
END`);
  }
}

/** Restarts backfill (rowid per kind) for every kind, newly enabled stores, or kinds whose content was just included. */
export function restartRecordCursors(db: Db, prev: ClickHouseConfig, next: ClickHouseConfig, everything: boolean): void {
  const cursors = JSON.parse((db.prepare('SELECT record_cursors FROM clickhouse_export').get() as { record_cursors: string }).record_cursors) as Record<string, number>;
  for (const spec of RECORD_SPECS) {
    const contentAdded = !!spec.withContent && next.includeBodies && !prev.includeBodies;
    if (next.stores[spec.store] && (everything || !prev.stores[spec.store] || contentAdded)) cursors[spec.kind] = 0;
  }
  db.prepare('UPDATE clickhouse_export SET record_cursors=?').run(JSON.stringify(cursors));
}

// Each pass queues at most this many references per kind, keeping the worker transaction short.
const BACKFILL_CHUNK_ROWS = 5_000;
/** Queues references for existing rows; returns whether any kind still has rows left. */
export function backfillRecords(db: Db, config: ClickHouseConfig): boolean {
  const cursors = JSON.parse((db.prepare('SELECT record_cursors FROM clickhouse_export').get() as { record_cursors: string }).record_cursors) as Record<string, number>;
  for (const spec of RECORD_SPECS) {
    const from = cursors[spec.kind];
    if (from === undefined) continue;
    if (!config.stores[spec.store]) { delete cursors[spec.kind]; continue; }
    const { last, n } = db.prepare(`SELECT max(rowid) AS last, count(*) AS n FROM (SELECT rowid FROM ${spec.table} t WHERE rowid>? AND ${kindFilter(spec, 't')} ORDER BY rowid LIMIT ?)`).get(from, BACKFILL_CHUNK_ROWS) as { last: number | null; n: number };
    if (last === null) { delete cursors[spec.kind]; continue; }
    db.prepare(`INSERT INTO clickhouse_outbox(${OUTBOX_COLUMNS}) SELECT ${reference(spec, 't')} FROM ${spec.table} t
      WHERE t.rowid>? AND t.rowid<=? AND ${kindFilter(spec, 't')} AND NOT EXISTS (SELECT 1 FROM clickhouse_outbox o WHERE o.kind='${spec.kind}' AND o.record_key=${sql(spec.key, 't')})`).run(from, last);
    // A short chunk reached the end of the table.
    if (n < BACKFILL_CHUNK_ROWS) delete cursors[spec.kind]; else cursors[spec.kind] = last;
  }
  db.prepare('UPDATE clickhouse_export SET record_cursors=?').run(JSON.stringify(cursors));
  return Object.keys(cursors).length > 0;
}

export interface ResolvedRecord { record: string; trace: string; at: string; content: boolean }
/** Current value of a queued record, or null once the row is gone (pruned, cleared or replaced). */
export function resolveRecord(db: Db, kind: string, key: string, includeContent: boolean): ResolvedRecord | null {
  const spec = recordSpec(kind);
  if (!spec) return null;
  const content = includeContent && !!spec.withContent;
  const row = db.prepare(`SELECT ${sql(content ? spec.withContent! : spec.record, 't')} AS record, ${sql(spec.trace, 't')} AS trace, coalesce(${sql(spec.at, 't')},${NOW}) AS at
    FROM ${spec.table} t WHERE ${sql(spec.key, 't')}=? AND ${kindFilter(spec, 't')} LIMIT 1`).get(key) as Omit<ResolvedRecord, 'content'> | undefined;
  return row ? { ...row, content } : null;
}

export interface UsageRecord { kind: 'usage-sample' | 'usage-window' | 'usage-span'; key: string; at: string; record: string }
/** Mirrors usage history for export; unchanged rows skip the update, so their triggers stay quiet. */
export function mirrorUsage(db: Db, config: ClickHouseConfig, records: UsageRecord[], oldestAt: string): void {
  // Main pushes the whole history again when export or the usage store turns on.
  if (!config.enabled || !config.stores.usage) { db.exec('DELETE FROM clickhouse_usage'); return; }
  const upsert = db.prepare('INSERT INTO clickhouse_usage(kind,key,at,record) VALUES(?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET at=excluded.at,record=excluded.record WHERE record<>excluded.record');
  db.transaction(() => {
    for (const r of records) upsert.run(r.kind, r.key, r.at, r.record);
    db.prepare('DELETE FROM clickhouse_usage WHERE at<?').run(oldestAt);
  })();
}
