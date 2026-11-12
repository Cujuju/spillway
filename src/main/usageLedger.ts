import { addEvent, DETAIL_KEYS, emptyCounts, localDay, localHourStart, scaleDetailCosts } from '@shared/activityCounts';
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

const metadataStatementsFor = connectionStatements({
  readRequest: 'SELECT event FROM requests WHERE id = ?',
  updateRequest: 'UPDATE requests SET event = ? WHERE id = ?',
});

export interface IdentityRow { key: string; event: string; row_id: number; matched: number; source: string; at: string; provider: string; client: string | null; upstream_id: string | null }
export function identityEvent(row: IdentityRow): ActivityEvent {
  return { ...JSON.parse(row.event), source: row.source, at: row.at, provider: row.provider, client: row.client, upstreamId: row.upstream_id };
}
export const identityKey = (e: ActivityEvent): string => e.source === 'client-log' ? `client-log:${e.requestId}` : `proxy:${e.requestId}:${e.authIndex ?? ''}:${e.at}`;

export type AccountedActivityEvent = ActivityEvent & Partial<Pick<ActivityCounts, 'costUsd' | 'uncachedCostUsd' | 'latencyCount' | 'latencySumMs' | 'ttftCount' | 'ttftSumMs'>>;
/** Uses the cost actually counted when available, including migration's historical price scaling. */
export function accountedUsage(e: AccountedActivityEvent): ActivityCounts {
  const counts = emptyCounts();
  addEvent(counts, e);
  if (e.costUsd !== undefined) scaleDetailCosts(counts, e.costUsd);
  counts.costUsd = e.costUsd ?? counts.costUsd;
  counts.uncachedCostUsd = e.uncachedCostUsd ?? counts.uncachedCostUsd;
  return counts;
}

/** What an identity's request added to its total. Identities recorded before the detail fields (#155) added none of them. */
export function countedUsage(row: IdentityRow): ActivityCounts {
  const counts = accountedUsage(identityEvent(row));
  if ((JSON.parse(row.event) as { detail?: boolean }).detail !== true) for (const k of DETAIL_KEYS) counts[k] = 0;
  return counts;
}

/** Only accounting and match fields survive retention, including mergeable timing counts/sums. `detail` marks usage counted with the detail fields. */
export function rememberUsage(db: Db, e: AccountedActivityEvent, id: number, totalStart: number | null = localHourStart(Date.parse(e.at)), totalDay = localDay(Date.parse(e.at))): void {
  const { requestId, model, authIndex, sessionId, turnKey, thinkingTokens,
    inputTokens, outputTokens, cachedTokens, cacheWriteTokens, cacheWrite1hTokens, cacheWriteLongTokens, tier, failed } = e;
  const { costUsd, uncachedCostUsd, latencyCount, latencySumMs, ttftCount, ttftSumMs } = accountedUsage(e);
  const statements = statementsFor(db);
  statements.insert.run([identityKey(e), JSON.stringify({
    costUsd, uncachedCostUsd, latencyCount, latencySumMs, ttftCount, ttftSumMs,
    ...(e.effectiveModel ? { effectiveModel: e.effectiveModel } : {}), ...(e.reasoningEffort ? { reasoningEffort: e.reasoningEffort } : {}),
    totalStart, totalDay, requestId, model, authIndex, sessionId, turnKey, thinkingTokens, detail: true,
    inputTokens, outputTokens, cachedTokens, cacheWriteTokens, cacheWrite1hTokens, cacheWriteLongTokens, tier, failed,
  }), id, fallbackKey(e), e.upstreamId, e.source, e.at, e.provider, e.client]);
  if (e.source === 'proxy' && (e.upstreamId || e.sessionId)) {
    statements.boundary.run(e.at);
  }
}

/** Retention can recycle row IDs; only the identity or its matched partner owns the stored event. */
function ownedRequest(db: Db, identity: IdentityRow): ActivityEvent | undefined {
  const row = metadataStatementsFor(db).readRequest.get(identity.row_id) as { event: string } | undefined;
  if (!row) return undefined;
  const event = JSON.parse(row.event) as ActivityEvent;
  const key = identityKey(event);
  if (key === identity.key) return event;
  const partner = statementsFor(db).identity.get(key) as IdentityRow | undefined;
  if (identity.matched && partner?.matched && partner.source !== identity.source
    && partner.row_id === identity.row_id && sameUsage(identityEvent(identity), identityEvent(partner))) return event;
  return undefined;
}

function fillMetadata(db: Db, identity: IdentityRow, primary: ActivityEvent, secondary: ActivityEvent): void {
  const old = ownedRequest(db, identity);
  if (!old) return;
  const fields = { turnKey: primary.turnKey ?? secondary.turnKey ?? null, thinkingTokens: primary.thinkingTokens ?? secondary.thinkingTokens ?? null, clientVersion: primary.clientVersion ?? secondary.clientVersion ?? null, settingsHash: primary.settingsHash ?? secondary.settingsHash ?? null, reasoningEffort: primary.reasoningEffort ?? secondary.reasoningEffort ?? null };
  if (Object.entries(fields).some(([key, value]) => (old[key as keyof typeof fields] ?? null) !== value)) {
    metadataStatementsFor(db).updateRequest.run(JSON.stringify({ ...old, ...fields }), identity.row_id);
  }
  Object.assign(primary, fields);
}

/** Called inside the same transaction as totals, requests and checkpoints. */
export function reconcileUsage(db: Db, e: ActivityEvent): { skip: boolean; removeCounts?: ActivityCounts; removeKey?: string; relinkKey?: string; id?: number } {
  const statements = statementsFor(db);
  const existing = statements.identity.get(identityKey(e)) as IdentityRow | undefined;
  if (existing) {
    const old = identityEvent(existing);
    // Streaming blocks can precede final usage; copied earlier blocks must never undo the final count.
    if (e.source === 'client-log' && !existing.matched && ((!old.upstreamId && e.upstreamId) || e.outputTokens > old.outputTokens)) {
      statements.removeIdentity.run(identityKey(e));
      statements.removeRequest.run(existing.row_id, old.requestId);
      const updated = { ...e, upstreamId: e.upstreamId ?? old.upstreamId };
      return { ...reconcileUsage(db, updated), removeCounts: countedUsage(existing), removeKey: removalKey(existing) };
    }
    const retained = ownedRequest(db, existing);
    if (retained) fillMetadata(db, existing, retained, e);
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
  const other = ownedRequest(db, match) ?? identityEvent(match);
  if (e.source === 'client-log') { fillMetadata(db, match, other, e); return { skip: true, id: match.row_id }; }
  fillMetadata(db, match, e, other);
  statements.removeRequest.run(match.row_id, identityEvent(match).requestId);
  return { skip: false, removeCounts: countedUsage(match), removeKey: removalKey(match), relinkKey: match.key };
}

/** A legacy identity belongs to the daily baseline even if newer usage shares its hour. */
export function removalKey(row: IdentityRow): string {
  const e = identityEvent(row) as ActivityEvent & { totalStart?: number | null; totalDay?: string };
  return storedTotalKey({ ...e, day: e.totalDay ?? localDay(Date.parse(e.at)), start: e.totalStart ?? undefined });
}

/** Repair deleted transcript links only when a retained matched proxy is unambiguous. */
export function repairMatchedIdentities(db: Db): void {
  const missing = (db.prepare("SELECT * FROM usage_identities WHERE source = 'client-log' AND matched = 1").all() as IdentityRow[])
    .filter((row) => !ownedRequest(db, row));
  const candidates = db.prepare(`SELECT * FROM usage_identities AS i WHERE source = 'proxy' AND matched = 1
    AND (upstream_id = ? OR fallback_key = ?) AND EXISTS (SELECT 1 FROM requests WHERE id = i.row_id)`);
  const link = db.prepare('UPDATE usage_identities SET row_id = ? WHERE key = ?');
  for (const row of missing) {
    const event = identityEvent(row);
    const matches = (candidates.all(event.upstreamId, fallbackKey(event)) as IdentityRow[]).filter((other) => ownedRequest(db, other) && sameUsage(identityEvent(other), event));
    if (matches.length === 1) link.run(matches[0]!.row_id, row.key);
  }
}
