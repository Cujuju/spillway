import { localDay, localHourStart } from '@shared/activityCounts';
import type { ActivityCounts, ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { addToTotals, dailyTotals, readTotalRows, storedTotalKey, totalKey, type ActivityTotal } from './activityTotals';
import { accountedUsage, identityKey, rememberUsage } from './usageLedger';

/** Exact counts that prove a day's stored requests are the whole day. Cost is excluded: prices may have changed since. */
const USAGE_COUNTS = ['requests', 'failed', 'inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens', 'unpricedRequests'] as const;
/** Cost recorded at request time; the rebuild keeps it rather than repricing. */
const RECORDED_COSTS = ['costUsd', 'uncachedCostUsd'] as const;

const sameUsage = (a: ActivityCounts, b: ActivityCounts) => USAGE_COUNTS.every((k) => a[k] === b[k]);

/** Rebuilds each whole-day baseline as hourly totals when the day's stored requests account for all of it. Caller owns the transaction. */
export function rebuildRetainedTotals(db: Db): void {
  const stored = readTotalRows(db);
  const rawKeys = new Map(stored.map(({ key, total }) => [storedTotalKey(total), key]));
  const byDay = new Map<string, ActivityTotal[]>();
  for (const { total: t } of stored) {
    const rows = byDay.get(t.day) ?? [];
    rows.push(t);
    byDay.set(t.day, rows);
  }
  // Finish the single day-index scan before writing; SQLite forbids writes while its iterator is active.
  const candidates = new Set([...byDay].filter(([, rows]) => rows.some((t) => t.start === undefined)).map(([day]) => day));
  if (!candidates.size) return;
  let day = '';
  let events: RetainedRequest[] = [];
  for (const row of db.prepare('SELECT day, id, event FROM requests ORDER BY day').all() as { day: string; id: number; event: string }[]) {
    if (row.day !== day) {
      rebuildDay(db, day, byDay.get(day) ?? [], events, rawKeys);
      day = row.day;
      events = [];
    }
    if (candidates.has(day)) {
      const e = JSON.parse(row.event) as ActivityEvent;
      events.push({ id: row.id, event: { ...e, client: e.client ?? null, source: e.source ?? 'proxy', cacheWriteTokens: e.cacheWriteTokens ?? 0 } });
    }
  }
  rebuildDay(db, day, byDay.get(day) ?? [], events, rawKeys);
}

interface RetainedRequest { id: number; event: ActivityEvent }

function rebuildDay(db: Db, day: string, existing: ActivityTotal[], requests: RetainedRequest[], rawKeys: Map<string, string>): void {
  if (!existing.some((t) => t.start === undefined)) return;
  const pinBaseline = db.prepare("UPDATE usage_identities SET event = json_set(event, '$.totalDay', ?) WHERE key = ? AND json_extract(event, '$.totalStart') IS NULL");
  for (const { event: e } of requests) pinBaseline.run(day, identityKey(e));
  // Reject the entire day: ignoring misplaced requests cannot prove completeness.
  if (requests.some(({ event: e }) => localDay(Date.parse(e.at)) !== day)) return;
  const hours = new Map<string, ActivityTotal>();
  for (const { event: e } of requests) addToTotals(hours, e);
  const before = new Map(dailyTotals(existing).map((t) => [totalKey(t), t]));
  const after = dailyTotals(hours.values());
  if (after.length !== before.size || !after.every((t) => before.has(totalKey(t)) && sameUsage(before.get(totalKey(t))!, t))) return;
  const repriced = new Map(after.map((t) => [totalKey(t), t]));
  if (!keepRecordedCost(hours, before, repriced)) return;
  const remove = db.prepare('DELETE FROM activity_totals WHERE key = ?');
  const insert = db.prepare('INSERT INTO activity_totals (key, total) VALUES (?, ?)');
  const moveIdentity = db.prepare("UPDATE usage_identities SET event = json_set(event, '$.totalStart', ?, '$.totalDay', ?, '$.costUsd', ?, '$.uncachedCostUsd', ?) WHERE key = ?");
  for (const t of existing) remove.run(rawKeys.get(storedTotalKey(t))!);
  for (const t of hours.values()) insert.run(storedTotalKey(t), JSON.stringify(t));
  for (const { id, event: e } of requests) {
    const start = localHourStart(Date.parse(e.at));
    // Seed ownership explicitly; a matching hour on a mixed day proves nothing by itself.
    rememberUsage(db, e, id, start);
    const counts = accountedUsage(e);
    const key = totalKey({ ...e, day });
    for (const k of RECORDED_COSTS) {
      const total = repriced.get(key)![k];
      counts[k] = total === 0 ? 0 : counts[k] * (before.get(key)![k] / total);
    }
    moveIdentity.run(start, day, counts.costUsd, counts.uncachedCostUsd, identityKey(e));
  }
}

/** Scales each hour's cost so its day keeps the cost recorded then. False when there's no repriced cost to scale. */
function keepRecordedCost(hours: Map<string, ActivityTotal>, recorded: Map<string, ActivityTotal>, repriced: Map<string, ActivityTotal>): boolean {
  for (const k of RECORDED_COSTS) {
    for (const [key, day] of repriced) if (day[k] === 0 && recorded.get(key)![k] !== 0) return false;
  }
  for (const hour of hours.values()) {
    const key = totalKey(hour);
    for (const k of RECORDED_COSTS) {
      const total = repriced.get(key)![k];
      hour[k] = total === 0 ? 0 : hour[k] * (recorded.get(key)![k] / total);
    }
  }
  return true;
}
