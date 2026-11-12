import { parseRequestSettings } from '@shared/requestSettings';
import { requestSettingsHash } from './requestSettings';
import { sessionKind, type ActivityEvent } from '@shared/types';
import { clientName } from '@shared/activityScope';
import { activityTransport, transportReason } from '@shared/activityTransport';

export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental text/event-stream parser: feed chunks, get complete messages. Comments (": …") are skipped. */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = blocks.pop() ?? '';
    const out: SseMessage[] = [];
    for (const block of blocks) {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}

/** The proxy's mark on requests sent by POST /usage/start-window (docs/desktop-api.md in the fork). */
const WINDOW_START_PURPOSE = 'window-start';

const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const tokenSubset = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Parses a "request" event's JSON; null when it is not an object with a request id. */
export function parseActivityEvent(data: string): ActivityEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const requestId = s(r.request_id);
  // Window starts are the app's own requests; Activity records client traffic only.
  if (!requestId || (r.purpose === WINDOW_START_PURPOSE || r.purpose === 'canary' || r.purpose === 'thinking-test')) return null;
  const userAgent = s(r.user_agent);
  const settings = parseRequestSettings(r.request_settings);
  return {
    at: s(r.at) ?? new Date().toISOString(),
    requestId,
    turnKey: s(r.turn_key),
    thinkingTokens: typeof r.reasoning_tokens === 'number' && Number.isFinite(r.reasoning_tokens) && r.reasoning_tokens >= 0 ? r.reasoning_tokens : null,
    clientVersion: userAgent?.match(/^[^/\s]+\/([^\s]+)/)?.[1] ?? null,
    settingsHash: settings ? requestSettingsHash(settings) : null,
    ...(settings ? { requestSettings: settings } : {}),
    traceId: s(r.trace_id),
    upstreamId: s(r.upstream_id),
    source: 'proxy',
    selectionId: s(r.selection_id),
    provider: (s(r.provider) ?? 'unknown').toLowerCase(),
    model: s(r.alias) ?? s(r.model) ?? '',
    effectiveModel: s(r.model),
    reasoningEffort: s(r.reasoning_effort),
    authIndex: s(r.auth_index),
    stream: r.stream === true,
    downstreamTransport: activityTransport(r.downstream_transport),
    upstreamTransport: activityTransport(r.upstream_transport),
    transportFallbackReason: transportReason(r.transport_fallback_reason),
    failed: r.failed === true,
    statusCode: positive(r.status_code),
    error: s(r.error),
    latencyMs: positive(r.latency_ms),
    ttftMs: positive(r.ttft_ms),
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    cachedTokens: n(r.cached_tokens),
    cacheWriteTokens: n(r.cache_creation_tokens),
    cacheWrite1hTokens: tokenSubset(r.cache_creation_1h_tokens),
    cacheWriteLongTokens: tokenSubset(r.cache_creation_long_tokens),
    tier: r.tier === 'standard' || r.tier === 'fast' || r.tier === 'flex' ? r.tier : null,
    sessionId: s(r.session_id),
    parentSessionId: s(r.parent_session_id),
    sessionKind: sessionKind(r.session_kind),
    userAgent,
    client: clientName(userAgent),
    // Set when stored (activityLog.append), which knows the conversation's earlier requests.
    movedFrom: null,
  };
}
