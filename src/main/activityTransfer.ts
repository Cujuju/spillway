import { DETAIL_COST_KEYS, localDay } from '@shared/activityCounts';
import type { ActivityEvent, ActivityCounts } from '@shared/types';
import type { Db } from './activityDb';
import { accountedUsage, identityEvent, type AccountedActivityEvent, type IdentityRow } from './usageLedger';

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

/** Row ids may be reused after retention; all identity fields must still match the retained request. */
const RETAINED_IDENTITY_MATCH = `r.id = u.row_id AND json_extract(r.event, '$.requestId') = json_extract(u.event, '$.requestId')
  AND coalesce(json_extract(r.event, '$.source'), 'proxy') = u.source AND json_extract(r.event, '$.at') = u.at
  AND json_extract(r.event, '$.authIndex') IS json_extract(u.event, '$.authIndex')`;

export function* exportActivityEvents(db: Db): Generator<AccountedActivityEvent> {
  const retained = `SELECT r.event, json_extract(u.event, '$.costUsd') AS costUsd, json_extract(u.event, '$.uncachedCostUsd') AS uncachedCostUsd,
    json_extract(u.event, '$.latencyCount') AS latencyCount, json_extract(u.event, '$.latencySumMs') AS latencySumMs,
    json_extract(u.event, '$.ttftCount') AS ttftCount, json_extract(u.event, '$.ttftSumMs') AS ttftSumMs
    FROM requests r LEFT JOIN usage_identities u ON ${RETAINED_IDENTITY_MATCH} ORDER BY r.id`;
  for (const r of db.prepare(retained).iterate() as Iterable<{ event: string; costUsd: number | null; uncachedCostUsd: number | null;
    latencyCount: number | null; latencySumMs: number | null; ttftCount: number | null; ttftSumMs: number | null }>) {
    const e = JSON.parse(r.event) as AccountedActivityEvent;
    // The ledger records the samples actually counted. Older hourly totals had none, even if details retain a duration.
    yield { ...e, costUsd: r.costUsd ?? e.costUsd, uncachedCostUsd: r.uncachedCostUsd ?? e.uncachedCostUsd,
      latencyCount: r.latencyCount ?? e.latencyCount ?? 0, latencySumMs: r.latencySumMs ?? e.latencySumMs ?? 0,
      ttftCount: r.ttftCount ?? e.ttftCount ?? 0, ttftSumMs: r.ttftSumMs ?? e.ttftSumMs ?? 0 };
  }
  // Whole-day baselines without identities cannot be deduplicated and remain local.
  const sql = `SELECT u.* FROM usage_identities u WHERE NOT EXISTS (SELECT 1 FROM requests r
    WHERE ${RETAINED_IDENTITY_MATCH}) ORDER BY u.rowid`;
  for (const r of db.prepare(sql).iterate() as Iterable<IdentityRow>) yield identityEvent(r);
}

export function preserveImportedCost(row: ActivityCounts, e: ActivityEvent): void {
  const priced = accountedUsage({ ...e, costUsd: undefined, uncachedCostUsd: undefined });
  const counted = accountedUsage(e);
  row.costUsd += counted.costUsd - priced.costUsd;
  row.uncachedCostUsd += counted.uncachedCostUsd - priced.uncachedCostUsd;
  for (const k of DETAIL_COST_KEYS) row[k] += counted[k] - priced[k];
}
