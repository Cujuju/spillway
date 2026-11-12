import { ARCHIVE_MAX_BYTES } from './archive';
/** Local stores the export can send; each has its own switch. */
export const CLICKHOUSE_STORES = ['traces', 'requests', 'titles', 'totals', 'usage', 'drift', 'evals'] as const;
export type ClickHouseStoreName = typeof CLICKHOUSE_STORES[number];
export type ClickHouseStores = Record<ClickHouseStoreName, boolean>;
// Turning export on sends everything unless a store is switched off.
const ALL_STORES = Object.fromEntries(CLICKHOUSE_STORES.map((s) => [s, true])) as ClickHouseStores;
export interface ClickHouseConfig {
  enabled: boolean; endpoint: string; database: string; tablePrefix: string; includeBodies: boolean; sourceLabel: string; stores: ClickHouseStores;
}
export interface ClickHouseCredentials { username: string; password: string }
export const DEFAULT_CLICKHOUSE_CONFIG: ClickHouseConfig = { enabled: false, endpoint: '', database: 'default', tablePrefix: 'spillway', includeBodies: false, sourceLabel: '', stores: ALL_STORES };
// The outbox holds at least as much content as the archive can retain.
export const CLICKHOUSE_OUTBOX_BYTES = ARCHIVE_MAX_BYTES;
export const CLICKHOUSE_SOURCE_LABEL_MAX = 64;
/** Error prefix the settings page matches to offer Create tables instead of Check. */
export const CLICKHOUSE_TABLES_MISSING = 'ClickHouse tables are missing';
/** Error prefix the settings page matches to offer Upgrade tables for schema v1 tables. */
export const CLICKHOUSE_TABLES_OUTDATED = 'ClickHouse tables use schema v1';
export const CLICKHOUSE_BATCH_BYTES = 8 * 1024 * 1024;
// ClickHouse recommends at least 1,000 rows per insert to reduce part creation overhead.
export const CLICKHOUSE_BATCH_ROWS = 1_000;
export interface ClickHouseStatus {
  config: ClickHouseConfig; hasCredentials: boolean; queued: number; queuedBytes: number; oldestQueuedAt: string | null;
  acknowledged: number; discarded: number; oversized: number; contentExpired: number; attempts: number; nextAttemptAt: number; lastAcknowledgedAt: string | null;
  error: string | null; running: boolean; paused: boolean; backfilling: boolean;
}
export interface ClickHouseBatch { token: string; destination: string; pieces: string; facts: string; rows: number; attempts: number; nextAttemptAt: number }
const TABLE_SUFFIX_LENGTH = "_pieces".length;
export function validateClickHouseConfig(raw: unknown): ClickHouseConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid ClickHouse settings');
  const r = raw as ClickHouseConfig;
  if (typeof r.enabled !== 'boolean' || typeof r.includeBodies !== 'boolean') throw new Error('Invalid ClickHouse policy');
  if (![r.database, r.tablePrefix].every((v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(v))) throw new Error('Database and table must be simple SQL identifiers (up to 63 characters)');
  if (r.tablePrefix.length > 63 - TABLE_SUFFIX_LENGTH) throw new Error('Table prefix is too long');
  if (typeof r.endpoint !== 'string' || r.endpoint.length > 2048) throw new Error('Invalid ClickHouse endpoint');
  let endpoint = '';
  if (r.endpoint) {
    let url: URL;
    try { url = new URL(r.endpoint); } catch { throw new Error('Enter an HTTP(S) origin without credentials, path, query or fragment'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter an HTTP(S) origin without credentials, path, query or fragment');
    endpoint = url.origin;
  }
  if (r.enabled && !endpoint) throw new Error('An endpoint is required to enable ClickHouse');
  const sourceLabel = r.sourceLabel === undefined ? '' : r.sourceLabel;
  if (typeof sourceLabel !== 'string' || sourceLabel.trim().length > CLICKHOUSE_SOURCE_LABEL_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(sourceLabel)) throw new Error('Invalid ClickHouse source label');
  // Configs saved before per-store switches lack `stores`; every store defaults on.
  const rawStores: unknown = r.stores ?? ALL_STORES;
  if (!rawStores || typeof rawStores !== 'object') throw new Error('Invalid ClickHouse stores');
  const stores = Object.fromEntries(CLICKHOUSE_STORES.map((name) => {
    const value = (rawStores as Partial<ClickHouseStores>)[name] ?? true;
    if (typeof value !== 'boolean') throw new Error('Invalid ClickHouse stores');
    return [name, value];
  })) as ClickHouseStores;
  return { stores, sourceLabel: sourceLabel.trim(), enabled: r.enabled, includeBodies: r.includeBodies, endpoint, database: r.database, tablePrefix: r.tablePrefix };
}
export function validateClickHouseCredentials(raw: unknown): ClickHouseCredentials {
  const r = raw as ClickHouseCredentials | null;
  if (!r || typeof r.username !== 'string' || typeof r.password !== 'string' || r.username.length > 256 || r.password.length > 4096 || /[\u0000-\u001f\u007f]/.test(r.username + r.password)) throw new Error('Invalid ClickHouse credentials');
  if (/[^\u0000-\u00ff]/.test(r.username + r.password)) throw new Error('ClickHouse credentials must use Latin-1 characters for HTTP headers');
  return { username: r.username, password: r.password };
}
