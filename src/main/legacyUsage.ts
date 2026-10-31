import type { ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { accountedUsage, identityEvent, removalKey, type IdentityRow } from './usageLedger';
import { USAGE_MATCH_TOLERANCE_MS } from './usageMerge';
import type { ActivityTotal } from './activityTotals';

const BACKFILL = 'legacy-usage-matched';
const MS_PER_SECOND = 1000;
const SIGNATURE = `json_array(json_extract(event, '$.model'), json_extract(event, '$.inputTokens'),
  json_extract(event, '$.outputTokens'), json_extract(event, '$.cachedTokens'), coalesce(json_extract(event, '$.cacheWriteTokens'), 0))`;
const LEGACY = `source = 'proxy' AND upstream_id IS NULL AND json_extract(event, '$.sessionId') IS NULL AND at < ?`;

/** Equality fields precede the timestamp range; coverage indexes cannot narrow by token signature. */
function index(db: Db): void {
  db.exec(`CREATE INDEX IF NOT EXISTS usage_legacy_match ON usage_identities (source, provider, ${SIGNATURE}, unixepoch(at, 'subsec')) WHERE matched = 0`);
}

/** Select every pair before changing matched flags, preserving ambiguity across the entire batch. */
export function matchLegacyUsage(db: Db, keys?: string[]): number {
  const boundary = (db.prepare("SELECT value FROM meta WHERE key = 'first-matchable-proxy'").get() as { value: string } | undefined)?.value;
  if (!boundary) return 0;
  index(db);
  const get = db.prepare('SELECT * FROM usage_identities WHERE key = ? AND matched = 0');
  const rows = keys ? keys.flatMap((key) => {
    const row = get.get(key) as IdentityRow | undefined;
    return row ? [row] : [];
  }) : db.prepare(`SELECT * FROM usage_identities WHERE matched = 0 AND ${LEGACY}`).all(boundary) as IdentityRow[];
  const candidates = db.prepare(`SELECT * FROM usage_identities WHERE matched = 0
    AND source = ? AND provider = ? AND ${SIGNATURE} = ?
    AND unixepoch(at, 'subsec') BETWEEN unixepoch(?, 'subsec') - ? AND unixepoch(?, 'subsec') + ?
    AND (source = 'client-log' OR (${LEGACY})) LIMIT 2`);
  const eligible = (e: ActivityEvent) => e.source === 'client-log'
    || (e.source === 'proxy' && !e.upstreamId && !e.sessionId && e.at < boundary);
  const find = (e: ActivityEvent): IdentityRow[] => (candidates.all(e.source === 'proxy' ? 'client-log' : 'proxy', e.provider,
    JSON.stringify([e.model, e.inputTokens, e.outputTokens, e.cachedTokens, e.cacheWriteTokens ?? 0]),
    e.at, USAGE_MATCH_TOLERANCE_MS / MS_PER_SECOND, e.at, USAGE_MATCH_TOLERANCE_MS / MS_PER_SECOND, boundary) as IdentityRow[]);
  const pairs = new Map<string, [IdentityRow, IdentityRow]>();
  for (const row of rows) {
    const e = identityEvent(row);
    if (!eligible(e)) continue;
    const matches = find(e);
    if (matches.length !== 1) continue;
    const other = matches[0]!;
    const reverse = find(identityEvent(other));
    if (reverse.length !== 1 || reverse[0]!.key !== row.key) continue;
    const [proxy, client] = e.source === 'proxy' ? [row, other] : [other, row];
    pairs.set(proxy.key, [proxy, client]);
  }
  const update = db.prepare('UPDATE usage_identities SET matched = 1, row_id = ? WHERE key IN (?, ?)');
  const remove = db.prepare("DELETE FROM requests WHERE id = ? AND json_extract(event, '$.source') = 'client-log' AND json_extract(event, '$.requestId') = ?");
  const total = db.prepare('SELECT total FROM activity_totals WHERE key = ?');
  const save = db.prepare('UPDATE activity_totals SET total = ? WHERE key = ?');
  for (const [proxy, client] of pairs.values()) {
    const e = identityEvent(client);
    const key = removalKey(client);
    const stored = total.get(key) as { total: string } | undefined;
    if (stored) {
      const row = JSON.parse(stored.total) as ActivityTotal;
      const counts = accountedUsage(e);
      for (const k of Object.keys(counts) as (keyof typeof counts)[]) row[k] -= counts[k];
      save.run(JSON.stringify(row), key);
    }
    remove.run(client.row_id, e.requestId);
    update.run(proxy.row_id, proxy.key, client.key);
  }
  return pairs.size;
}

/** Failure rolls back accounting and the marker; the worker can keep serving and retry next launch. */
export function backfillLegacyUsage(db: Db): void {
  if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(BACKFILL)) return;
  try {
    db.transaction(() => {
      matchLegacyUsage(db);
      db.prepare('INSERT INTO meta VALUES (?, ?)').run(BACKFILL, '1');
    })();
  } catch (error) {
    console.error('[activity] legacy matching failed; retrying next launch:', error);
  }
}
