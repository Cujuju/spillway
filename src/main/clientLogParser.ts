import { createHash } from 'node:crypto';
import { clientName } from '@shared/activityScope';
import type { ActivityEvent } from '@shared/types';

export interface LogContext { session?: string; model?: string; client?: string; turn?: string; total?: string; pendingRecord?: string; pendingSnapshot?: { usage: string; identity: string; at: string } }
type Json = Record<string, any>;
const tokens = (n: unknown): number => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
const usageTotal = (u: Json | undefined): string | undefined => u ? JSON.stringify([u.input_tokens, u.cached_input_tokens, u.cache_write_input_tokens ?? 0, u.output_tokens, u.reasoning_output_tokens ?? 0]) : undefined;
const text = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;

/** Stateful per-file parser; context is checkpointed alongside the byte offset. No prompt or response text is retained. */
export function parseClientLine(line: string, provider: 'claude' | 'codex', context: LogContext): ActivityEvent | null {
  let r: Json;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || typeof r !== 'object') return null;
  let usage: Json | undefined;
  let upstreamId: string | null = null;
  let identity: string;
  if (provider === 'claude') {
    if (r.type !== 'assistant' || !r.message?.usage || r.message.model === '<synthetic>') return null;
    usage = r.message.usage;
    upstreamId = text(r.message.id);
    if (!upstreamId) return null;
    context.session = text(r.sessionId) ?? undefined;
    context.model = text(r.message.model) ?? undefined;
    context.client = 'claude-cli';
    identity = `${upstreamId}:${text(r.requestId) ?? ''}`;
  } else {
    const p = r.payload;
    if (!p || typeof p !== 'object') return null;
    if (r.type === 'session_meta') {
      context.session = text(p.session_id) ?? text(p.id) ?? undefined;
      context.client = clientName(text(p.originator)) ?? undefined;
    }
    if (r.type === 'turn_context') {
      context.model = text(p.model) ?? context.model;
      context.turn = text(p.turn_id) ?? undefined;
    }
    if (r.type === 'token_usage_record' && p.usage) {
      usage = p.usage;
      upstreamId = text(p.response_id);
      context.session = text(p.session_id) ?? context.session;
      context.turn = text(p.turn_id) ?? context.turn;
      const signature = usageTotal(usage)!;
      const previous = context.pendingSnapshot;
      const paired = previous?.usage === signature && Date.parse(r.timestamp) <= Date.parse(previous.at);
      identity = paired ? previous.identity : upstreamId ?? `${context.session}:${context.turn}:${r.timestamp}`;
      context.pendingRecord = paired ? undefined : signature;
      context.pendingSnapshot = undefined;
    } else {
      if (r.type !== 'event_msg' || p.type !== 'token_count' || !p.info?.last_token_usage) return null;
      // Codex emits unchanged last_token_usage again on rate-limit updates and after token_usage_record.
      const total = usageTotal(p.info.total_token_usage);
      if (total && context.total === total) return null;
      context.total = total;
      usage = p.info.last_token_usage;
      const signature = usageTotal(usage)!;
      if (context.pendingRecord === signature) {
        context.pendingRecord = undefined;
        return null;
      }
      context.pendingRecord = undefined;
      upstreamId = text(p.response_id) ?? text(p.info.response_id) ?? text(r.response_id);
      identity = upstreamId ?? `${context.session}:${context.turn}:${total ?? r.timestamp}`;
      context.pendingSnapshot = { usage: signature, identity, at: r.timestamp };
    }

  }
  const at = text(r.timestamp);
  if (!at || !Number.isFinite(Date.parse(at)) || !context.model || !usage) return null;
  return {
    at, requestId: `client-log:${provider}:${createHash('sha256').update(identity).digest('hex')}`,
    upstreamId, source: 'client-log', selectionId: null, provider, model: context.model,
    authIndex: null, stream: true, failed: false, statusCode: null, error: null, latencyMs: 0, ttftMs: null,
    inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens),
    cachedTokens: tokens(provider === 'claude' ? usage.cache_read_input_tokens : usage.cached_input_tokens),
    cacheWriteTokens: tokens(provider === 'claude' ? usage.cache_creation_input_tokens : usage.cache_write_input_tokens),
    sessionId: context.session ? `${provider}:${context.session}` : null,
    movedFrom: null, userAgent: null, client: context.client ?? null,
  };
}
