import { localDay } from '@shared/activityCounts';
import { inScope, normalizeScope } from '@shared/activityScope';
import { OLDER_DAYS_WINDOW, type OlderBuckets, type OlderDays, type OlderDaysQuery, type OlderPage, type OlderPageQuery, type OlderRead } from '@shared/activityOlder';
import { validateClickHouseConfig, type ClickHouseConfig, type ClickHouseCredentials } from '@shared/clickhouse';
import { appLocale } from '@shared/timeFormat';
import { ACTIVITY_PAGE_SIZE, type ActivityDaySummary } from '@shared/types';
import { DAY_KEY } from './activityDb';
import { toStored } from './activityRequestRow';
import type { ActivityLog } from './activityStore';
import { normalizeTotal, toBucket, type ActivityTotal } from './activityTotals';
import { clickhouseRequest, clickhouseTable } from './clickhouseHttp';

const BUCKET_ROW_CAP = 10_000, DAY_GROUP_CAP = 10_000, REQUEST_ROW_CAP = 10 * ACTIVITY_PAGE_SIZE;
// Allows roughly 1.6 KiB per bucket or 3.2 KiB per request at the row caps.
const READ_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const DATETIME64_MIN_MS = Date.parse('1900-01-01T00:00:00Z');
const AT_RANGE = 'at >= fromUnixTimestamp64Milli({from:Int64}) AND at < fromUnixTimestamp64Milli({to:Int64})';
const EMPTY_BUCKETS = { buckets: [], truncated: false };
const EMPTY_DAYS = { days: [], from: '', earlier: false };
const EMPTY_PAGE = { events: [], more: false, truncated: false };

type Kind = 'request' | 'total';
type Params = Record<string, number | string>;
type Row = Record<string, unknown>;
type Query = <T>(sql: string, params: Params, decode: (row: Row) => T) => Promise<T[]>;
type Boundaries = ReturnType<ActivityLog['activityOlderBoundaries']>;
class ReadFailure extends Error {}

function requireRow(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid row');
  return value as Row;
}
function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid string column');
  return value;
}
const nonnegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const midnight = (day: string) => Date.parse(`${day}T00:00:00`);
const isDay = (day: unknown): day is string => typeof day === 'string' && DAY_KEY.test(day) && localDay(midnight(day)) === day;
function shiftDay(day: string, days: number): string {
  const date = new Date(midnight(day));
  date.setDate(date.getDate() + days);
  return localDay(date.getTime());
}
const ok = <T>(value: T): OlderRead<T> => ({ state: 'ok', ...value });

// A request keeps its `at` across re-exports, and a row id reused after Clear activity carries another.
// A total's key already names its hour or day.
const DEDUPE_KEY: Record<Kind, string> = { request: 'source_id, record_key, at', total: 'source_id, record_key' };
const latest = (table: string, kind: Kind) => `SELECT at, seq, source_id, record_key, record_json FROM ${table}
WHERE kind = {kind:String} AND ${AT_RANGE}
ORDER BY seq DESC LIMIT 1 BY ${DEDUPE_KEY[kind]}`;
const records = (table: string, kind: Kind) => `SELECT record_json FROM (
${latest(table, kind)}
)
ORDER BY at DESC, seq DESC, source_id, record_key LIMIT {limit:UInt64} FORMAT JSONEachRow`;

function decodeBucket(row: Row) {
  const record = requireRow(JSON.parse(requireString(row.record_json)));
  const total = requireRow(record.total);
  if (!isDay(total.day) || typeof total.provider !== 'string' || typeof total.model !== 'string'
    || (total.start !== undefined && !nonnegativeInt(total.start))) throw new Error('Invalid total');
  return toBucket(normalizeTotal(total as unknown as ActivityTotal));
}
function decodeRequest(row: Row) {
  const event = toStored({ id: 0, event: requireString(row.record_json) });
  if (typeof event.requestId !== 'string' || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
    || typeof event.failed !== 'boolean' || typeof event.provider !== 'string' || typeof event.model !== 'string') throw new Error('Invalid request');
  return event;
}
function decodeDayGroup(row: Row) {
  const day = row.day;
  const requests = typeof row.requests === 'string' && /^\d+$/.test(row.requests) ? Number(row.requests) : row.requests;
  const failed = row.failed;
  if (!isDay(day) || !nonnegativeInt(requests) || ![true, false, 0, 1].includes(failed as boolean | number)) throw new Error('Invalid day group');
  return { day, requests, failed: failed ? requests : 0,
    authIndex: requireString(row.authIndex) || null, client: requireString(row.client) || null,
    source: requireString(row.source) || 'proxy', reasoningEffort: requireString(row.reasoningEffort) || null };
}

export class ClickHouseActivityReader {
  private readonly abort = new AbortController();

  constructor(
    private readonly status: () => Promise<{ config: ClickHouseConfig }>,
    private readonly boundaries: () => Promise<Boundaries>,
    private readonly credentials: (config: ClickHouseConfig) => ClickHouseCredentials | undefined,
  ) {}

  stop(): void { this.abort.abort(); }

  private async read<T>(action: (query: Query, table: string, boundaries: Boundaries) => Promise<T>): Promise<OlderRead<T>> {
    try {
      const { config: raw } = await this.status();
      if (!raw.enabled || !raw.endpoint) return { state: 'off' };
      const config = validateClickHouseConfig(raw);
      const boundaries = await this.boundaries();
      const credentials = this.credentials(config), signal = this.abort.signal;
      const query: Query = async (sql, params, decode) => {
        if (signal.aborted) throw new ReadFailure('ClickHouse read cancelled');
        const body = await clickhouseRequest(config, credentials, sql, signal, { params, maxBytes: READ_RESPONSE_LIMIT_BYTES })
          .catch((e: Error) => { throw new ReadFailure(e.message); });
        try { return body.trim().split('\n').filter(Boolean).map((line) => decode(requireRow(JSON.parse(line)))); }
        catch { throw new ReadFailure('ClickHouse read returned an unexpected response'); }
      };
      return ok(await action(query, clickhouseTable(config), boundaries));
    } catch (error) {
      return { state: 'unavailable', error: error instanceof ReadFailure ? error.message : 'ClickHouse read is unavailable' };
    }
  }

  async buckets(span: { from: number; to: number } | undefined): Promise<OlderRead<OlderBuckets>> {
    if (!nonnegativeInt(span?.from) || !nonnegativeInt(span?.to) || span.from > span.to) return ok(EMPTY_BUCKETS);
    return this.read(async (query, table, boundaries) => {
      const from = span.from, to = Math.min(span.to + 1, boundaries.totals === null ? Infinity : midnight(boundaries.totals));
      if (from >= to) return EMPTY_BUCKETS;
      const rows = await query(records(table, 'total'), { kind: 'total', from, to, limit: BUCKET_ROW_CAP + 1 }, decodeBucket);
      return { buckets: rows.slice(0, BUCKET_ROW_CAP), truncated: rows.length > BUCKET_ROW_CAP };
    });
  }

  async days(input: Partial<OlderDaysQuery> | undefined): Promise<OlderRead<OlderDays>> {
    const before = input?.before;
    if (before !== null && !isDay(before)) return ok(EMPTY_DAYS);
    const scope = normalizeScope(input?.scope);
    return this.read(async (query, table, boundaries) => {
      const end = before !== null && before < boundaries.requests ? before : boundaries.requests;
      const from = shiftDay(end, -OLDER_DAYS_WINDOW);
      const startMs = midnight(from), endMs = midnight(end);
      const sql = `SELECT formatDateTime(at, '%F', {zone:String}) AS day,
  JSONExtractString(record_json, 'authIndex') AS authIndex,
  JSONExtractString(record_json, 'client') AS client,
  JSONExtractString(record_json, 'source') AS source,
  JSONExtractString(record_json, 'reasoningEffort') AS reasoningEffort,
  JSONExtractBool(record_json, 'failed') AS failed, count() AS requests
FROM (
${latest(table, 'request')}
)
GROUP BY day, authIndex, client, source, reasoningEffort, failed
ORDER BY day DESC LIMIT {limit:UInt64} FORMAT JSONEachRow`;
      const groups = await query(sql, { kind: 'request', from: startMs, to: endMs,
        zone: Intl.DateTimeFormat(appLocale()).resolvedOptions().timeZone, limit: DAY_GROUP_CAP + 1 }, decodeDayGroup);
      if (groups.length > DAY_GROUP_CAP) throw new ReadFailure('ClickHouse day summaries exceeded row limit');
      const days = new Map<string, ActivityDaySummary>();
      for (const group of groups) {
        if (!inScope(scope, group)) continue;
        const summary = days.get(group.day) ?? { day: group.day, requests: 0, failed: 0, newestId: 0, costUsd: 0, unpricedRequests: 0 };
        summary.requests += group.requests;
        summary.failed += group.failed;
        days.set(group.day, summary);
      }
      const exists = `SELECT 1 AS present FROM ${table}
WHERE kind = {kind:String} AND ${AT_RANGE}
LIMIT {limit:UInt64} FORMAT JSONEachRow`;
      const older = startMs > DATETIME64_MIN_MS ? await query(exists, { kind: 'request', from: DATETIME64_MIN_MS, to: startMs, limit: 1 }, (row) => {
        if (row.present !== 1) throw new Error('Invalid existence result');
        return true;
      }) : [];
      return { days: [...days.values()], from, earlier: older.length > 0 };
    });
  }

  async page(input: Partial<OlderPageQuery> | undefined): Promise<OlderRead<OlderPage>> {
    const day = input?.day, offset = input?.offset;
    if (!isDay(day) || !nonnegativeInt(offset)) return ok(EMPTY_PAGE);
    const scope = normalizeScope(input?.scope);
    const failedOnly = input?.failedOnly === true, whole = input?.whole === true;
    return this.read(async (query, table, boundaries) => {
      if (day >= boundaries.requests) return EMPTY_PAGE;
      const rows = await query(records(table, 'request'), { kind: 'request', from: midnight(day), to: midnight(shiftDay(day, 1)), limit: REQUEST_ROW_CAP + 1 }, decodeRequest);
      const scoped = rows.slice(0, REQUEST_ROW_CAP).filter((row) => (!failedOnly || row.failed) && inScope(scope, row));
      const start = whole ? 0 : offset, end = whole ? scoped.length : offset + ACTIVITY_PAGE_SIZE;
      return { events: scoped.slice(start, end).map((row, i) => ({ ...row, id: -(start + i + 1) })),
        more: scoped.length > end, truncated: rows.length > REQUEST_ROW_CAP };
    });
  }
}
