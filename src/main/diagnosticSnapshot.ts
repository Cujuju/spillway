import type { ArchiveStore } from './archiveStore';
import type { Db } from './activityDb';
import { DIAGNOSTIC_LIMITS, type DiagnosticSource, type DiagnosticAttempt } from '@shared/diagnosticBundle';
import type { ActivityEvent } from '@shared/types';
import { normalizeTransport } from '@shared/activityTransport';

type RetainedLink = { requestId: string; selectionId: string | null; at: string; provenance?: Partial<DiagnosticAttempt> | null };
function fromLink(link: RetainedLink): DiagnosticAttempt {
  const p = link.provenance?.source === 'proxy' ? link.provenance : undefined;
  return { requestId: link.requestId, selectionId: link.selectionId, at: link.at, metadataSource: p ? 'archive-link' : 'unavailable',
    model: p?.model ?? null, effectiveModel: p?.effectiveModel ?? null, reasoningEffort: p?.reasoningEffort ?? null,
    provider: p?.provider ?? null, client: p?.client ?? null, sessionId: p?.sessionId ?? null, parentSessionId: p?.parentSessionId ?? null,
    failed: p?.failed ?? null, statusCode: p?.statusCode ?? null, latencyMs: p?.latencyMs ?? null, ttftMs: p?.ttftMs ?? null,
    ...normalizeTransport(p ?? {}),
  };
}

/** Called only inside the Activity worker; no second database connection or body import. */
export function diagnosticSnapshot(db: Db, archive: ArchiveStore, traceId: string, includeBodies: boolean): DiagnosticSource {
  if (typeof traceId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(traceId)) throw new Error('Invalid diagnostic trace identity');
  return db.transaction(() => {
    const detail = archive.detail(traceId);
    if (!detail) return { detail: null, attempts: [], attemptsOmitted: 0, attemptsUnavailable: 0 };
    const where = "json_extract(event,'$.traceId')=? AND coalesce(json_extract(event,'$.source'),'proxy')='proxy'";
    const count = (db.prepare(`SELECT count(*) AS n FROM requests WHERE ${where}`).get(traceId) as { n: number }).n;
    const attempts: DiagnosticAttempt[] = (db.prepare(`SELECT event FROM requests WHERE ${where} ORDER BY id LIMIT ?`).all(traceId, DIAGNOSTIC_LIMITS.attempts) as { event: string }[]).map((r) => ({ ...JSON.parse(r.event) as ActivityEvent, metadataSource: 'activity' }));
    const identity = (a: { requestId: string; selectionId?: string | null; at: string }) => JSON.stringify([a.requestId, a.selectionId ?? null, a.at]);
    const linkKeys = detail.attempts.map(identity);
    const identitySql = "json_array(json_extract(event,'$.requestId'),json_extract(event,'$.selectionId'),json_extract(event,'$.at'))";
    const existing = new Set((db.prepare(`SELECT DISTINCT ${identitySql} AS identity FROM requests WHERE ${where} AND ${identitySql} IN (SELECT value FROM json_each(?))`).all(traceId, JSON.stringify(linkKeys)) as { identity: string }[]).map((r) => r.identity));
    const links = detail.attempts.filter((a) => !existing.has(identity(a)));
    const attemptsUnavailable = links.length;
    const fallback = links.slice(0, DIAGNOSTIC_LIMITS.attempts - attempts.length).map(fromLink);
    if (!includeBodies) { detail.request = ''; detail.response = ''; detail.frames = []; }
    return { detail, attempts: [...attempts, ...fallback], attemptsOmitted: Math.max(0, count - attempts.length) + links.length - fallback.length, attemptsUnavailable };
  })();
}
