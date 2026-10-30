import type { ActivityEvent } from '@shared/types';

/** Client timestamps mark receipt; proxy timestamps can mark request start. Allows ordinary long responses on one machine. */
export const USAGE_MATCH_TOLERANCE_MS = 5 * 60_000;
export type UsageIdentity = Pick<ActivityEvent, 'upstreamId' | 'sessionId' | 'provider' | 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'at'>;
export const normalizedSession = (s: string | null): string | null => s?.replace(/:agent:.*$/, '') ?? null;

export const fallbackKey = (e: UsageIdentity): string => JSON.stringify([
  normalizedSession(e.sessionId), e.provider, e.inputTokens, e.outputTokens, e.cachedTokens, e.cacheWriteTokens,
]);

/** Distinct known response IDs never fall back to a heuristic. Unknown sessions never match heuristically. */
export function sameUsage(a: UsageIdentity, b: UsageIdentity): boolean {
  if (a.provider !== b.provider) return false;
  if (a.upstreamId && b.upstreamId) return a.upstreamId === b.upstreamId;
  return !!a.sessionId && normalizedSession(a.sessionId) === normalizedSession(b.sessionId)
    && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens
    && a.cachedTokens === b.cachedTokens && a.cacheWriteTokens === b.cacheWriteTokens
    && Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= USAGE_MATCH_TOLERANCE_MS;
}

/** One-to-one matching preserves separate requests with identical usage. Proxy order and rows are preserved. */
export function mergeUsage(proxy: ActivityEvent[], imported: ActivityEvent[]): ActivityEvent[] {
  const used = new Set<number>();
  const seen = new Set<string>();
  return [...proxy, ...imported.filter((e) => {
    if (seen.has(e.requestId)) return false;
    seen.add(e.requestId);
    const exact = e.upstreamId ? proxy.findIndex((p, n) => !used.has(n) && p.upstreamId === e.upstreamId && sameUsage(p, e)) : -1;
    const i = exact >= 0 ? exact : proxy.findIndex((p, n) => !used.has(n) && sameUsage(p, e));
    if (i < 0) return true;
    used.add(i);
    return false;
  })];
}
