import { localDay } from '@shared/activityCounts';
import type { ActivityEvent, ActivityCounts } from '@shared/types';
import type { Db } from './activityDb';
import { accountedUsage, identityEvent, type IdentityRow } from './usageLedger';

/** Oldest local day inside the newest `retentionDays` days ending today. */
export function oldestKeptDay(today: number, retentionDays: number): string {
  const d = new Date(today);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (retentionDays - 1)).getTime());
}
/** Local days, YYYY-MM-DD, from `count - 1` days before `today` through today. */
export function lastDays(today: number, count: number): string[] {
  const d = new Date(today);
  return Array.from({ length: count }, (_, i) => localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (count - 1 - i)).getTime()));
}

export function* exportActivityEvents(db: Db): Generator<ActivityEvent> {
  for (const r of db.prepare('SELECT event FROM requests ORDER BY id').iterate() as Iterable<{ event: string }>) yield JSON.parse(r.event);
  // Whole-day baselines without identities cannot be deduplicated and remain local.
  const sql = `SELECT u.* FROM usage_identities u WHERE NOT EXISTS (SELECT 1 FROM requests r
    WHERE r.id = u.row_id AND json_extract(r.event, '$.requestId') = json_extract(u.event, '$.requestId') AND coalesce(json_extract(r.event, '$.source'), 'proxy') = u.source AND json_extract(r.event, '$.at') = u.at AND json_extract(r.event, '$.authIndex') IS json_extract(u.event, '$.authIndex')) ORDER BY u.rowid`;
  for (const r of db.prepare(sql).iterate() as Iterable<IdentityRow>) yield identityEvent(r);
}

export function preserveImportedCost(row: ActivityCounts, e: ActivityEvent): void {
  const priced = accountedUsage({ ...e, costUsd: undefined, uncachedCostUsd: undefined });
  const counted = accountedUsage(e);
  row.costUsd += counted.costUsd - priced.costUsd;
  row.uncachedCostUsd += counted.uncachedCostUsd - priced.uncachedCostUsd;
}
