import { localDay, localHourStart } from '@shared/activityCounts';
import type { ActivityCounts, ActivityEvent } from '@shared/types';
import { totalKey, type Db } from './activityDb';
import { addToTotals, dailyTotals, readTotals, storedTotalKey, type ActivityTotal } from './activityTotals';
import { identityKey } from './usageLedger';

/** Exact counts that prove a day's stored requests are the whole day. Cost is excluded: prices may have changed since. */
const USAGE_COUNTS = ['requests', 'failed', 'inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens', 'unpricedRequests'] as const;
/** Cost recorded at request time; the rebuild keeps it rather than repricing. */
const RECORDED_COSTS = ['costUsd', 'uncachedCostUsd'] as const;

const sameUsage = (a: ActivityCounts, b: ActivityCounts) => USAGE_COUNTS.every((k) => a[k] === b[k]);

/** Rebuilds each whole-day baseline as hourly totals when the day's stored requests account for all of it. Caller owns the transaction. */
export function rebuildRetainedTotals(db: Db): void {
  const totals = readTotals(db);
  const byDay = new Map<string, ActivityTotal[]>();
  for (const t of totals.values()) byDay.set(t.day, [...(byDay.get(t.day) ?? []), t]);
  const requests = db.prepare('SELECT event FROM requests WHERE day = ?');
  const remove = db.prepare('DELETE FROM activity_totals WHERE key = ?');
  const insert = db.prepare('INSERT INTO activity_totals (key, total) VALUES (?, ?)');
  const moveIdentity = db.prepare("UPDATE usage_identities SET event = json_set(event, '$.totalStart', ?) WHERE key = ?");
  for (const [day, existing] of byDay) {
    if (existing.every((t) => t.start !== undefined)) continue;
    const events = (requests.all(day) as { event: string }[]).map(({ event }) => JSON.parse(event) as ActivityEvent);
    const hours = new Map<string, ActivityTotal>();
    for (const e of events) {
      // A request filed under another local day (time-zone change) can't prove this day complete.
      if (localDay(Date.parse(e.at)) === day) addToTotals(hours, { ...e, client: e.client ?? null, cacheWriteTokens: e.cacheWriteTokens ?? 0 });
    }
    const before = new Map(dailyTotals(existing).map((t) => [totalKey(t), t]));
    const after = dailyTotals(hours.values());
    if (after.length !== before.size || !after.every((t) => before.has(totalKey(t)) && sameUsage(before.get(totalKey(t))!, t))) continue;
    if (!keepRecordedCost(hours, before)) continue;
    for (const t of existing) remove.run(storedTotalKey(t));
    for (const t of hours.values()) insert.run(storedTotalKey(t), JSON.stringify(t));
    for (const e of events) moveIdentity.run(localHourStart(Date.parse(e.at)), identityKey(e));
  }
}

/** Scales each hour's cost so its day keeps the cost recorded then. False when there's no repriced cost to scale. */
function keepRecordedCost(hours: Map<string, ActivityTotal>, recorded: Map<string, ActivityTotal>): boolean {
  const repriced = new Map(dailyTotals(hours.values()).map((t) => [totalKey(t), t]));
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

/** Ledger seeding follows the total that actually owns this request. */
export function retainedTotalStart(db: Db, e: ActivityEvent): number | null {
  const start = localHourStart(Date.parse(e.at));
  const key = storedTotalKey({ ...e, day: localDay(Date.parse(e.at)), start });
  return db.prepare('SELECT 1 FROM activity_totals WHERE key = ?').get(key) ? start : null;
}
