import { localDay, localHourStart } from '@shared/activityCounts';
import { storedTotalKey } from './activityTotals';
import type { ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { fallbackKey, sameUsage } from './usageMerge';

interface IdentityRow { key: string; event: string; row_id: number; matched: number }
export const identityKey = (e: ActivityEvent): string => e.source === 'client-log' ? `client-log:${e.requestId}` : `proxy:${e.requestId}:${e.authIndex ?? ''}:${e.at}`;

/** Only accounting and match fields survive request retention; no error text, headers or timings. */
export function rememberUsage(db: Db, e: ActivityEvent, id: number, totalStart: number | null = localHourStart(Date.parse(e.at))): void {
  const { requestId, source, upstreamId, at, provider, model, authIndex, client, sessionId,
    inputTokens, outputTokens, cachedTokens, cacheWriteTokens, failed } = e;
  db.prepare('INSERT OR IGNORE INTO usage_identities (key, event, row_id, fallback_key, upstream_id, source) VALUES (?, ?, ?, ?, ?, ?)').run(identityKey(e), JSON.stringify({
    totalStart, requestId, source, upstreamId, at, provider, model, authIndex, client, sessionId,
    inputTokens, outputTokens, cachedTokens, cacheWriteTokens, failed,
  }), id, fallbackKey(e), e.upstreamId, e.source);
}

/** Called inside the same transaction as totals, requests and checkpoints. */
export function reconcileUsage(db: Db, e: ActivityEvent): { skip: boolean; remove?: ActivityEvent; removeKey?: string; id?: number } {
  const existing = db.prepare('SELECT * FROM usage_identities WHERE key = ?').get(identityKey(e)) as IdentityRow | undefined;
  if (existing) {
    const old = JSON.parse(existing.event) as ActivityEvent;
    // Streaming blocks can precede final usage; copied earlier blocks must never undo the final count.
    if (e.source === 'client-log' && !existing.matched && ((!old.upstreamId && e.upstreamId) || e.outputTokens > old.outputTokens)) {
      db.prepare('DELETE FROM usage_identities WHERE key = ?').run(identityKey(e));
      db.prepare("DELETE FROM requests WHERE id = ? AND json_extract(event, '$.source') = 'client-log' AND json_extract(event, '$.requestId') = ?").run(existing.row_id, old.requestId);
      const updated = { ...e, upstreamId: e.upstreamId ?? old.upstreamId };
      return { ...reconcileUsage(db, updated), remove: old, removeKey: removalKey(existing.event) };
    }
    return { skip: true, id: existing.row_id };
  }
  const opposite = e.source === 'proxy' ? 'client-log' : 'proxy';
  const byUpstream = e.upstreamId ? db.prepare(`SELECT key, event, row_id FROM usage_identities
    WHERE upstream_id = ? AND source = ? AND matched = 0`).all(e.upstreamId, opposite) as IdentityRow[] : [];
  const bySession = e.sessionId ? db.prepare(`SELECT key, event, row_id FROM usage_identities
    WHERE fallback_key = ? AND source = ? AND matched = 0`).all(fallbackKey(e), opposite) as IdentityRow[] : [];
  const match = [...byUpstream, ...bySession].find((r) => sameUsage(JSON.parse(r.event), e));
  if (!match) return { skip: false };
  db.prepare('UPDATE usage_identities SET matched = 1 WHERE key = ?').run(match.key);
  rememberUsage(db, e, e.source === 'proxy' ? 0 : match.row_id);
  db.prepare('UPDATE usage_identities SET matched = 1 WHERE key = ?').run(identityKey(e));
  if (e.source === 'client-log') return { skip: true, id: match.row_id };
  db.prepare("DELETE FROM requests WHERE id = ? AND json_extract(event, '$.source') = 'client-log' AND json_extract(event, '$.requestId') = ?").run(match.row_id, (JSON.parse(match.event) as ActivityEvent).requestId);
  return { skip: false, remove: JSON.parse(match.event) as ActivityEvent, removeKey: removalKey(match.event) };
}

/** A legacy identity belongs to the daily baseline even if newer usage shares its hour. */
function removalKey(json: string): string {
  const e = JSON.parse(json) as ActivityEvent & { totalStart?: number | null };
  return storedTotalKey({ ...e, day: localDay(Date.parse(e.at)), start: e.totalStart ?? undefined });
}
