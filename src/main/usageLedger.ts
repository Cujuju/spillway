import { addEvent, emptyCounts, localDay, localHourStart } from '@shared/activityCounts';
import { storedTotalKey } from './activityTotals';
import type { ActivityCounts, ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { fallbackKey, sameUsage } from './usageMerge';
import { connectionStatements } from './connectionStatements';

const statementsFor = connectionStatements({
  insert: 'INSERT OR IGNORE INTO usage_identities (key, event, row_id, fallback_key, upstream_id, source, at, provider, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  boundary: "INSERT INTO meta (key, value) VALUES ('first-matchable-proxy', ?) ON CONFLICT(key) DO UPDATE SET value = min(value, excluded.value)",
  identity: 'SELECT * FROM usage_identities WHERE key = ?',
  removeIdentity: 'DELETE FROM usage_identities WHERE key = ?',
  removeRequest: "DELETE FROM requests WHERE id = ? AND json_extract(event, '$.source') = 'client-log' AND json_extract(event, '$.requestId') = ?",
  upstream: 'SELECT * FROM usage_identities WHERE upstream_id = ? AND source = ? AND matched = 0',
  session: 'SELECT * FROM usage_identities WHERE fallback_key = ? AND source = ? AND matched = 0',
  matched: 'UPDATE usage_identities SET matched = 1 WHERE key = ?',
});

export interface IdentityRow { key: string; event: string; row_id: number; matched: number; source: string; at: string; provider: string; client: string | null; upstream_id: string | null }
export function identityEvent(row: IdentityRow): ActivityEvent {
  return { ...JSON.parse(row.event), source: row.source, at: row.at, provider: row.provider, client: row.client, upstreamId: row.upstream_id };
}
export const identityKey = (e: ActivityEvent): string => e.source === 'client-log' ? `client-log:${e.requestId}` : `proxy:${e.requestId}:${e.authIndex ?? ''}:${e.at}`;

export type AccountedActivityEvent = ActivityEvent & Partial<Pick<ActivityCounts, 'costUsd' | 'uncachedCostUsd'>>;
/** Uses the cost actually counted when available, including migration's historical price scaling. */
export function accountedUsage(e: AccountedActivityEvent): ActivityCounts {
  const counts = emptyCounts();
  addEvent(counts, e);
  counts.costUsd = e.costUsd ?? counts.costUsd;
  counts.uncachedCostUsd = e.uncachedCostUsd ?? counts.uncachedCostUsd;
  return counts;
}

/** Only accounting and match fields survive request retention; no error text, headers or timings. */
export function rememberUsage(db: Db, e: ActivityEvent, id: number, totalStart: number | null = localHourStart(Date.parse(e.at)), totalDay = localDay(Date.parse(e.at))): void {
  const { requestId, model, authIndex, sessionId,
    inputTokens, outputTokens, cachedTokens, cacheWriteTokens, failed } = e;
  const { costUsd, uncachedCostUsd } = accountedUsage(e);
  const statements = statementsFor(db);
  statements.insert.run([identityKey(e), JSON.stringify({
    costUsd, uncachedCostUsd,
    totalStart, totalDay, requestId, model, authIndex, sessionId,
    inputTokens, outputTokens, cachedTokens, cacheWriteTokens, failed,
  }), id, fallbackKey(e), e.upstreamId, e.source, e.at, e.provider, e.client]);
  if (e.source === 'proxy' && (e.upstreamId || e.sessionId)) {
    statements.boundary.run(e.at);
  }
}

/** Called inside the same transaction as totals, requests and checkpoints. */
export function reconcileUsage(db: Db, e: ActivityEvent): { skip: boolean; remove?: ActivityEvent; removeKey?: string; id?: number } {
  const statements = statementsFor(db);
  const existing = statements.identity.get(identityKey(e)) as IdentityRow | undefined;
  if (existing) {
    const old = identityEvent(existing);
    // Streaming blocks can precede final usage; copied earlier blocks must never undo the final count.
    if (e.source === 'client-log' && !existing.matched && ((!old.upstreamId && e.upstreamId) || e.outputTokens > old.outputTokens)) {
      statements.removeIdentity.run(identityKey(e));
      statements.removeRequest.run(existing.row_id, old.requestId);
      const updated = { ...e, upstreamId: e.upstreamId ?? old.upstreamId };
      return { ...reconcileUsage(db, updated), remove: old, removeKey: removalKey(existing) };
    }
    return { skip: true, id: existing.row_id };
  }
  const opposite = e.source === 'proxy' ? 'client-log' : 'proxy';
  const byUpstream = e.upstreamId ? statements.upstream.all(e.upstreamId, opposite) as IdentityRow[] : [];
  const bySession = e.sessionId ? statements.session.all(fallbackKey(e), opposite) as IdentityRow[] : [];
  const match = [...byUpstream, ...bySession].find((r) => sameUsage(identityEvent(r), e));
  if (!match) return { skip: false };
  statements.matched.run(match.key);
  rememberUsage(db, e, e.source === 'proxy' ? 0 : match.row_id);
  statements.matched.run(identityKey(e));
  if (e.source === 'client-log') return { skip: true, id: match.row_id };
  statements.removeRequest.run(match.row_id, identityEvent(match).requestId);
  return { skip: false, remove: identityEvent(match), removeKey: removalKey(match) };
}

/** A legacy identity belongs to the daily baseline even if newer usage shares its hour. */
export function removalKey(row: IdentityRow): string {
  const e = identityEvent(row) as ActivityEvent & { totalStart?: number | null; totalDay?: string };
  return storedTotalKey({ ...e, day: e.totalDay ?? localDay(Date.parse(e.at)), start: e.totalStart ?? undefined });
}
