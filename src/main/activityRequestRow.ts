import { normalizeTransport } from '@shared/activityTransport';
import type { ActivityEvent, StoredActivityEvent } from '@shared/types';

export interface RequestRow {
  id: number;
  event: string;
}

export function toStored(r: RequestRow): StoredActivityEvent {
  // Requests stored before conversations or clients were recorded lack these fields.
  const e = JSON.parse(r.event) as Omit<ActivityEvent, 'sessionId' | 'movedFrom' | 'userAgent' | 'client'> & Partial<ActivityEvent>;
  return { ...e, ...normalizeTransport(e), effectiveModel: e.effectiveModel ?? null, reasoningEffort: e.reasoningEffort ?? null, parentSessionId: e.parentSessionId ?? null, sessionKind: e.sessionKind ?? null,
    latencyMs: e.source === 'client-log' ? null : e.latencyMs ?? null, ttftMs: e.source === 'client-log' ? null : e.ttftMs ?? null,
    source: e.source ?? 'proxy', upstreamId: e.upstreamId ?? null, cacheWriteTokens: e.cacheWriteTokens ?? 0, sessionId: e.sessionId ?? null, movedFrom: e.movedFrom ?? null, userAgent: e.userAgent ?? null, client: e.client ?? null, id: r.id };
}
