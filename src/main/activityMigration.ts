import { localDay, localHourStart } from '@shared/activityCounts';
import type { ActivityCounts, ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { addToTotals, dailyTotals, readTotals, storedTotalKey, totalKey, type ActivityTotal } from './activityTotals';
import { identityKey, rememberUsage } from './usageLedger';

/** Exact counts that prove a day's stored requests are the whole day. Cost is excluded: prices may have changed since. */
const USAGE_COUNTS = ['requests', 'failed', 'inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens', 'unpricedRequests'] as const;
/** Cost recorded at request time; the rebuild keeps it rather than repricing. */
const RECORDED_COSTS = ['costUsd', 'uncachedCostUsd'] as const;

const sameUsage = (a: ActivityCounts, b: ActivityCounts) => USAGE_COUNTS.every((k) => a[k] === b[k]);

/** Rebuilds each whole-day baseline as hourly totals when the day's stored requests account for all of it. Caller owns the transaction. */
export function rebuildRetainedTotals(db: Db): void {
  const totals = readTotals(db);
  const byDay = new Map<string, ActivityTotal[]>();
  for (const t of totals.values()) {
    const rows = byDay.get(t.day) ?? [];
    rows.push(t);
    byDay.set(t.day, rows);
  }
  // Scan the day index once; only candidate days need JSON parsing.
  const candidates = new Set([...byDay].filter(([, rows]) => rows.some((t) => t.start === undefined)).map(([day]) => day));
  let day = '';
  let events: RetainedRequest[] = [];
  for (const row of db.prepare('SELECT day, id, event FROM requests ORDER BY day').iterate() as Iterable<{ day: string; id: number; event: string }>) {
    if (row.day !== day) {
      rebuildDay(db, day, byDay.get(day) ?? [], events);
      day = row.day;
      events = [];
    }
    if (candidates.has(day)) {
      const e = JSON.parse(row.event) as ActivityEvent;
      events.push({ id: row.id, event: { ...e, client: e.client ?? null, source: e.source ?? 'proxy', cacheWriteTokens: e.cacheWriteTokens ?? 0 } });
    }
  }
  rebuildDay(db, day, byDay.get(day) ?? [], events);
}

interface RetainedRequest { id: number; event: ActivityEvent }

function rebuildDay(db: Db, day: string, existing: ActivityTotal[], requests: RetainedRequest[]): void {
  if (!existing.some((t) => t.start === undefined)) return;
  // Reject the entire day: ignoring misplaced requests cannot prove completeness.
  if (requests.some(({ event: e }) => localDay(Date.parse(e.at)) !== day)) return;
  const hours = new Map<string, ActivityTotal>();
  for (const { event: e } of requests) addToTotals(hours, e);
  const before = new Map(dailyTotals(existing).map((t) => [totalKey(t), t]));
  const after = dailyTotals(hours.values());
  if (after.length !== before.size || !after.every((t) => before.has(totalKey(t)) && sameUsage(before.get(totalKey(t))!, t))) return;
  if (!keepRecordedCost(hours, before)) return;
  const remove = db.prepare('DELETE FROM activity_totals WHERE key = ?');
  const insert = db.prepare('INSERT INTO activity_totals (key, total) VALUES (?, ?)');
  const moveIdentity = db.prepare("UPDATE usage_identities SET event = json_set(event, '$.totalStart', ?) WHERE key = ?");
  for (const t of existing) remove.run(storedTotalKey(t));
  for (const t of hours.values()) insert.run(storedTotalKey(t), JSON.stringify(t));
  for (const { id, event: e } of requests) {
    const start = localHourStart(Date.parse(e.at));
    // Seed ownership explicitly; a matching hour on a mixed day proves nothing by itself.
    rememberUsage(db, e, id, start);
    moveIdentity.run(start, identityKey(e));
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
