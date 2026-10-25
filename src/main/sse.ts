import type { ActivityEvent } from '@shared/types';

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

const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const positive = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);

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
  if (!requestId) return null;
  return {
    at: s(r.at) ?? new Date().toISOString(),
    requestId,
    selectionId: s(r.selection_id),
    provider: (s(r.provider) ?? 'unknown').toLowerCase(),
    model: s(r.alias) ?? s(r.model) ?? '',
    authIndex: s(r.auth_index),
    stream: r.stream === true,
    failed: r.failed === true,
    statusCode: positive(r.status_code),
    error: s(r.error),
    latencyMs: n(r.latency_ms),
    ttftMs: positive(r.ttft_ms),
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    cachedTokens: n(r.cached_tokens),
  };
}
