import type { ActivityEvent } from '@shared/types';

let sequence = 0;
export const thinkingEvent = (at: number, patch: Partial<ActivityEvent>): ActivityEvent => ({
  at: new Date(at).toISOString(), requestId: `r${sequence++}`, selectionId: null, upstreamId: null, source: 'proxy',
  provider: 'claude', model: 'claude-opus-5-5', effectiveModel: 'claude-opus-5-5', reasoningEffort: 'high', authIndex: 'a', stream: true, failed: false,
  statusCode: 200, error: null, latencyMs: 10, ttftMs: 1, inputTokens: 1000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0,
  sessionId: null, movedFrom: null, userAgent: null, client: 'cli', ...patch,
});
