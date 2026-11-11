import { addCounts, addEvent, emptyCounts, localDay, localHourStart } from '@shared/activityCounts';
import { priceTableSnapshot, repriceStart } from '@shared/modelPrices';
import type { ActivityCounts, ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { readTotalRows, storedTotalKey } from './activityTotals';
import { identityEvent, identityKey, type IdentityRow } from './usageLedger';
import { sameUsage, USAGE_MATCH_TOLERANCE_MS } from './usageMerge';

export const PRICE_TABLE_KEY = 'activity-price-table';
/** Independent imports need distinct markers even when no price snapshot exists. */
const INVALIDATION_BYTES = 16;
export function invalidateActivityPrices(db: Db): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(PRICE_TABLE_KEY);
  db.exec(`INSERT OR REPLACE INTO meta VALUES ('activity-price-invalidation', hex(randomblob(${INVALIDATION_BYTES})))`);
}
/** Sub-nanodollar differences are floating-point accumulation noise, not a price change. */
const COST_EPSILON_USD = 1e-9;
const equalCost = (a: number | undefined, b: number): boolean => typeof a === 'number' && Math.abs(a - b) <= COST_EPSILON_USD;
const COST_FIELDS = ['costUsd', 'uncachedCostUsd', 'unpricedRequests'] as const;
/** Unpriced requests are a pricing result, not evidence of retention completeness. */
const RETENTION_COUNTS = ['requests', 'failed', 'inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens'] as const;
const MODEL_DATE_SUFFIX = /-\d{8}$/;
type StoredCosts = Partial<Pick<ActivityCounts, 'costUsd' | 'uncachedCostUsd'>>;
type Request = { id: number; day: string; event: string };
const sameCosts = (a: StoredCosts, b: Pick<ActivityCounts, 'costUsd' | 'uncachedCostUsd'>): boolean => equalCost(a.costUsd, b.costUsd) && equalCost(a.uncachedCostUsd, b.uncachedCostUsd);
type RepricedRequest = { id: number | null; keys: string[]; costUsd: number; uncachedCostUsd: number };
type Group = { counts: ActivityCounts; requests: RepricedRequest[]; affected: boolean; misplaced: boolean };

/** Startup checks read only this marker; all scans belong to the repricing worker. */
export function activityPriceSnapshot(db: Db): string | null {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(PRICE_TABLE_KEY) as { value: string } | undefined)?.value ?? null;
}

/** Commits newest local days first. A failed day leaves the snapshot pending for an idempotent retry. */
export function repriceActivity(db: Db): boolean {
  const next = priceTableSnapshot();
  let prev = activityPriceSnapshot(db);
  if (prev === next) return false;
  const invalidation = () => (db.prepare("SELECT value FROM meta WHERE key = 'activity-price-invalidation'").get() as { value: string } | undefined)?.value;
  const generation = db.transaction(() => {
    prev = activityPriceSnapshot(db);
    return invalidation();
  }).immediate();
  const changes = repriceStart(prev, next);
  let changed = false;
  if (changes.size) {
    const starts = [...changes.values()];
    const earliest = starts.includes(null) ? null : starts.filter((d): d is string => d !== null).sort()[0]!;
    // UTC price boundaries can fall on the preceding local day.
    const UTC_DAY_MS = 24 * 60 * 60 * 1000;
    const from = earliest === null ? null : new Date(Date.parse(earliest) - UTC_DAY_MS).toISOString().split('T')[0]!;
    const days = db.prepare(`SELECT DISTINCT day FROM requests${from === null ? '' : ' WHERE day >= ?'} ORDER BY day DESC`)
      .all(...(from === null ? [] : [from])) as { day: string }[];
    for (const { day } of days) {
      changed = db.transaction(() => {
        const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
        repriceRetained(db, changes, day);
        return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n !== before;
      }).immediate() || changed;
    }
  }
  db.transaction(() => {
    if (invalidation() === generation) db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(PRICE_TABLE_KEY, next);
  }).immediate();
  return changed;
}

function repriceRetained(db: Db, changes: Map<string, string | null>, day: string): void {
  const totals = readTotalRows(db, day);
  const totalKeys = new Set(totals.map(({ total }) => storedTotalKey(total)));
  const identity = db.prepare('SELECT * FROM usage_identities WHERE key = ?');
  const partners = db.prepare('SELECT * FROM usage_identities WHERE matched = 1 AND row_id IN (SELECT id FROM requests WHERE day = ?) ORDER BY row_id').iterate(day) as IterableIterator<IdentityRow>;
  let partner = partners.next();
  const boundary = (db.prepare("SELECT value FROM meta WHERE key = 'first-matchable-proxy'").get() as { value: string } | undefined)?.value;
  const groups = new Map<string, Group>();
  const rows = db.prepare('SELECT id, day, event FROM requests INDEXED BY requests_by_day WHERE day = ? ORDER BY id').iterate(day) as Iterable<Request>;
  try {
    for (const row of rows) {
      const e = JSON.parse(row.event) as ActivityEvent & StoredCosts;
      e.source ??= 'proxy';
      e.client ??= null;
      e.cacheWriteTokens ??= 0;
      const model = (e.effectiveModel ?? e.model).trim().toLowerCase();
      const changedId = changes.has(model) ? model : model.replace(MODEL_DATE_SUFFIX, '');
      if (!changes.has(changedId)) continue;
      const matched: IdentityRow[] = [];
      while (!partner.done && partner.value.row_id <= row.id) {
        if (partner.value.row_id === row.id) matched.push(partner.value);
        partner = partners.next();
      }
      const eventKey = identityKey(e);
      const owner = matched.find((r) => r.key === eventKey) ?? identity.get(eventKey) as IdentityRow | undefined;
      const ownerEvent = owner ? identityEvent(owner) as ActivityEvent & StoredCosts & { totalDay?: string; totalStart?: number | null } : undefined;
      let key: string;
      if (ownerEvent) {
        key = storedTotalKey({ ...ownerEvent, day: ownerEvent.totalDay ?? localDay(Date.parse(ownerEvent.at)), start: ownerEvent.totalStart ?? undefined });
      } else {
        const hourKey = storedTotalKey({ ...e, day: row.day, start: localHourStart(Date.parse(e.at)) });
        key = totalKeys.has(hourKey) ? hourKey : storedTotalKey({ ...e, day: row.day });
      }
      const group = groups.get(key) ?? { counts: emptyCounts(), requests: [], affected: false, misplaced: false };
      const costs = emptyCounts();
      addEvent(costs, e);
      addCounts(group.counts, costs);
      const keys = ownerEvent && !sameCosts(ownerEvent, costs) ? [owner!.key] : [];
      if (owner?.matched && owner.row_id === row.id) {
        for (const partner of matched) {
          if (partner.source === e.source) continue;
          const partnerEvent = identityEvent(partner) as ActivityEvent & StoredCosts;
          if (!sameCosts(partnerEvent, costs) && matchesPartner(partnerEvent, e, boundary)) keys.push(partner.key);
        }
      }
      const id = ('costUsd' in e || 'uncachedCostUsd' in e) && !sameCosts(e, costs) ? row.id : null;
      if (id !== null || keys.length) group.requests.push({ id, keys, costUsd: costs.costUsd, uncachedCostUsd: costs.uncachedCostUsd });
      const start = changes.get(changedId)!;
      group.affected ||= start === null || Date.parse(e.at) >= Date.parse(start);
      // A misplaced request cannot prove that the stored total is complete.
      group.misplaced ||= localDay(Date.parse(e.at)) !== row.day;
      groups.set(key, group);
    }
  } finally {
    partners.return?.();
  }
  const saveTotal = db.prepare("UPDATE activity_totals SET total = json_set(total, '$.costUsd', ?, '$.uncachedCostUsd', ?, '$.unpricedRequests', ?) WHERE key = ?");
  const saveIdentity = db.prepare("UPDATE usage_identities SET event = json_set(event, '$.costUsd', ?, '$.uncachedCostUsd', ?) WHERE key = ?");
  const saveRequest = db.prepare("UPDATE requests SET event = json_set(event, '$.costUsd', ?, '$.uncachedCostUsd', ?) WHERE id = ? AND (json_type(event, '$.costUsd') IS NOT NULL OR json_type(event, '$.uncachedCostUsd') IS NOT NULL)");
  for (const { key, total } of totals) {
    const group = groups.get(storedTotalKey(total));
    if (!group?.affected || group.misplaced || !RETENTION_COUNTS.every((k) => total[k] === group.counts[k])) continue;
    if (!sameCosts(total, group.counts) || total.unpricedRequests !== group.counts.unpricedRequests) {
      saveTotal.run(...COST_FIELDS.map((k) => group.counts[k]), key);
    }
    for (const { id, keys, costUsd, uncachedCostUsd } of group.requests) {
      for (const identityKey of keys) saveIdentity.run(costUsd, uncachedCostUsd, identityKey);
      if (id !== null) saveRequest.run(costUsd, uncachedCostUsd, id);
    }
  }
}

/** Legacy matching requires a pre-boundary proxy, identical signature and nearby timestamps. */
function matchesPartner(a: ActivityEvent, b: ActivityEvent, boundary: string | undefined): boolean {
  if (sameUsage(a, b)) return true;
  const proxy = a.source === 'proxy' ? a : b;
  return !!boundary && !proxy.sessionId && !proxy.upstreamId && proxy.at < boundary
    && a.provider === b.provider && a.model === b.model
    && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens
    && a.cachedTokens === b.cachedTokens && (a.cacheWriteTokens ?? 0) === (b.cacheWriteTokens ?? 0)
    && Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= USAGE_MATCH_TOLERANCE_MS;
}
