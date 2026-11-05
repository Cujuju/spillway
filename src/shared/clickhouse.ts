export interface ClickHouseConfig {
  enabled: boolean; endpoint: string; database: string; table: string; includeBodies: boolean;
}
export interface ClickHouseCredentials { username: string; password: string }
export const DEFAULT_CLICKHOUSE_CONFIG: ClickHouseConfig = { enabled: false, endpoint: '', database: 'default', table: 'spillway_archive_v1', includeBodies: false };
export const CLICKHOUSE_QUEUE_LIMIT = 20_000;
export const CLICKHOUSE_BATCH_BYTES = 8 * 1024 * 1024;
export const CLICKHOUSE_BATCH_ROWS = 32;
export interface ClickHouseStatus {
  config: ClickHouseConfig; hasCredentials: boolean; queued: number; batchBytes: number; oldestQueuedAt: string | null;
  acknowledged: number; discarded: number; oversized: number; attempts: number; nextAttemptAt: number; lastAcknowledgedAt: string | null;
  error: string | null; running: boolean; paused: boolean;
}
export interface ClickHouseBatch { token: string; destination: string; payload: string; rows: { id: string; revision: number }[]; attempts: number; nextAttemptAt: number }
export function validateClickHouseConfig(raw: unknown): ClickHouseConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid ClickHouse settings');
  const r = raw as ClickHouseConfig;
  if (typeof r.enabled !== 'boolean' || typeof r.includeBodies !== 'boolean') throw new Error('Invalid ClickHouse policy');
  if (![r.database, r.table].every((v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(v))) throw new Error('Database and table must be simple SQL identifiers (up to 63 characters)');
  if (typeof r.endpoint !== 'string' || r.endpoint.length > 2048) throw new Error('Invalid ClickHouse endpoint');
  let endpoint = '';
  if (r.endpoint) {
    let url: URL;
    try { url = new URL(r.endpoint); } catch { throw new Error('Enter an HTTP(S) origin without credentials, path, query or fragment'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter an HTTP(S) origin without credentials, path, query or fragment');
    endpoint = url.origin;
  }
  if (r.enabled && !endpoint) throw new Error('An endpoint is required to enable ClickHouse');
  return { enabled: r.enabled, includeBodies: r.includeBodies, endpoint, database: r.database, table: r.table };
}
export function validateClickHouseCredentials(raw: unknown): ClickHouseCredentials {
  const r = raw as ClickHouseCredentials | null;
  if (!r || typeof r.username !== 'string' || typeof r.password !== 'string' || r.username.length > 256 || r.password.length > 4096 || /[\u0000-\u001f\u007f]/.test(r.username + r.password)) throw new Error('Invalid ClickHouse credentials');
  if (/[^\u0000-\u00ff]/.test(r.username + r.password)) throw new Error('ClickHouse credentials must use Latin-1 characters for HTTP headers');
  return { username: r.username, password: r.password };
}
