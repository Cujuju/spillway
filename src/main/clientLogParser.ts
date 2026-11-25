import { parseRequestSettings, type RequestSettings } from '@shared/requestSettings';
import { requestSettingsHash } from './requestSettings';
import { createHash } from 'node:crypto';
import { clientName } from '@shared/activityScope';
import type { ActivityEvent, SessionKind } from '@shared/types';
import type { ClientLogProvider } from './clientLogPaths';

export interface LogContext {
  version?: string;
  effort?: string;
  settings?: Record<string, RequestSettings | null>;
  session?: string;
  /** Legacy Codex session string preserved for fallback requestId hashes so subagent replays deduplicate. */
  hashSession?: string;
  parentSession?: string;
  sessionKind?: SessionKind;
  model?: string;
  client?: string;
  authIndex?: string | null;
  turn?: string;
  total?: string;
  pendingRecord?: string;
  pendingSnapshot?: { usage: string; identity: string; at: string };
}
type Json = Record<string, any>;
const ANTIGRAVITY_EFFORT_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i;

/** Splits Antigravity's encoded effort suffix ("gemini-4-neon-high" → model + "high"). */
export function splitAntigravityModelEffort(raw: string): { model: string; effort: string | null } {
  const trimmed = raw.trim();
  const match = ANTIGRAVITY_EFFORT_SUFFIX.exec(trimmed);
  return match ? { model: match[1]!, effort: match[2]!.toLowerCase() } : { model: trimmed, effort: null };
}
const tokens = (n: unknown): number => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
const usageTotal = (u: Json | undefined): string | undefined => u ? JSON.stringify([u.input_tokens, u.cached_input_tokens, u.cache_write_input_tokens ?? 0, u.output_tokens, u.reasoning_output_tokens ?? 0]) : undefined;
const text = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const isClaudeToolResult = (content: unknown): boolean => Array.isArray(content)
  && content.some((block) => typeof block === 'object' && block !== null && (block as Json).type === 'tool_result');
const hasClaudeThinkingBlock = (content: unknown): boolean => Array.isArray(content)
  && content.some((block) => typeof block === 'object' && block !== null && ((block as Json).type === 'thinking' || (block as Json).type === 'redacted_thinking'));

/** Stateful per-file parser; context is checkpointed alongside the byte offset. No prompt or response text is retained. */
export function parseClientLine(line: string, provider: ClientLogProvider, context: LogContext): ActivityEvent | null {
  let r: Json;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || typeof r !== 'object') return null;
  let usage: Json | undefined;
  let upstreamId: string | null = null;
  let identity: string;
  let at: string | null = text(r.timestamp);
  let explicitHasThinking: boolean | null = null;
  if (provider === 'claude') {
    if (r.type === 'api-request') {
      const value = parseRequestSettings(r.params);
      if (typeof r.params?.model === 'string') context.settings = { ...context.settings, [r.params.model]: value };
      return null;
    }
    context.version = text(r.version) ?? context.version;
    if (r.type === 'user') {
      if (r.isMeta !== true && r.isCompactSummary !== true && !isClaudeToolResult(r.message?.content)) {
        context.turn = text(r.promptId) ?? text(r.uuid) ?? text(r.timestamp) ?? context.turn;
      } else if (!context.turn) {
        context.turn = text(r.promptId) ?? undefined;
      }
      return null;
    }
    context.effort = text(r.perTurnEffort) ?? text(r.effort) ?? undefined;
    if (r.type !== 'assistant' || !r.message?.usage || r.message.model === '<synthetic>') return null;
    usage = r.message.usage;
    upstreamId = text(r.message.id);
    if (!upstreamId) return null;
    const rawSession = text(r.sessionId);
    const agentId = text(r.agentId);
    if (rawSession && (r.isSidechain === true || agentId)) {
      const subId = agentId ?? 'sidechain';
      context.session = `${rawSession}:agent:${subId}`;
      context.parentSession = rawSession;
      context.sessionKind = subId.startsWith('acompact') || r.isCompactSummary === true ? 'compaction' : 'subagent';
    } else {
      context.session = rawSession ?? undefined;
      context.parentSession = undefined;
      context.sessionKind = rawSession ? 'root' : undefined;
    }
    context.model = text(r.message.model) ?? undefined;
    context.client = 'claude-cli';
    if (hasClaudeThinkingBlock(r.message.content)) explicitHasThinking = true;
    identity = `${upstreamId}:${text(r.requestId) ?? ''}`;
  } else if (provider === 'antigravity') {
    if (r.type === 'USER_INPUT') {
      if (r.source !== 'SYSTEM') {
        const idx = typeof r.step_index === 'number' && Number.isFinite(r.step_index) ? String(r.step_index) : text(r.created_at) ?? text(r.timestamp);
        if (idx) context.turn = idx;
      }
      return null;
    }
    if (r.type !== 'PLANNER_RESPONSE' || r.status !== 'DONE') return null;
    if (typeof r.input_tokens !== 'number' && typeof r.output_tokens !== 'number') return null;
    const rawModel = text(r.model);
    at = text(r.created_at) ?? at;
    if (!rawModel || !at) return null;
    const { model, effort } = splitAntigravityModelEffort(rawModel);
    const cached = tokens(r.cache_read_tokens);
    // Antigravity logs uncached input apart from cache_read_tokens; normalize to total prompt tokens to match proxy/Gemini accounting.
    usage = {
      input_tokens: tokens(r.input_tokens) + cached,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: tokens(r.output_tokens),
      reasoning_output_tokens: r.thinking_tokens,
    };
    explicitHasThinking = typeof r.thinking === 'string' && r.thinking.trim().length > 0;
    upstreamId = text(r.response_id) ?? text(r.request_id);
    context.model = model;
    context.effort = effort ?? undefined;
    context.client = context.client ?? 'antigravity';
    const step = typeof r.step_index === 'number' && Number.isFinite(r.step_index) ? String(r.step_index) : '';
    identity = upstreamId ?? `${context.session ?? ''}:${step}:${at}`;
  } else {
    const p = r.payload;
    if (!p || typeof p !== 'object') return null;
    if (r.type === 'session_meta') {
      context.version = text(p.cli_version) ?? undefined;
      context.client = clientName(text(p.originator)) ?? undefined;
      const ownId = text(p.id);
      const metaSession = text(p.session_id);
      context.hashSession = metaSession ?? ownId ?? undefined;
      const subagent = p.source && typeof p.source === 'object' && p.source.subagent && typeof p.source.subagent === 'object' ? (p.source.subagent as Json) : null;
      const forkedFrom = text(p.forked_from_id);
      if (subagent) {
        const own = ownId ?? metaSession ?? undefined;
        const parent = text(subagent.thread_spawn?.parent_thread_id) ?? (metaSession && metaSession !== own ? metaSession : null);
        context.session = own;
        context.parentSession = parent && parent !== own ? parent : undefined;
        context.sessionKind = 'subagent';
      } else if (forkedFrom) {
        const own = ownId ?? metaSession ?? undefined;
        context.session = own;
        context.parentSession = forkedFrom !== own ? forkedFrom : undefined;
        context.sessionKind = 'fork';
      } else {
        context.session = metaSession ?? ownId ?? undefined;
        context.parentSession = undefined;
        context.sessionKind = context.session ? 'root' : undefined;
      }
    }
    if (r.type === 'turn_context') {
      context.effort = text(p.effort) ?? undefined;
      context.model = text(p.model) ?? context.model;
      context.turn = text(p.turn_id) ?? undefined;
    }
    if (r.type === 'token_usage_record' && p.usage) {
      usage = p.usage;
      upstreamId = text(p.response_id);
      const recordSession = text(p.session_id);
      context.hashSession = recordSession ?? context.hashSession;
      // Subagent token_usage_record carries the parent's session_id; keep the subagent's own thread id.
      if (context.sessionKind !== 'subagent' || !context.session) context.session = recordSession ?? context.session;
      context.turn = text(p.turn_id) ?? context.turn;
      const signature = usageTotal(usage)!;
      const previous = context.pendingSnapshot;
      const paired = previous?.usage === signature && Date.parse(r.timestamp) <= Date.parse(previous.at);
      identity = paired ? previous.identity : upstreamId ?? `${context.hashSession ?? context.session}:${context.turn}:${r.timestamp}`;
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
      identity = upstreamId ?? `${context.hashSession ?? context.session}:${context.turn}:${total ?? r.timestamp}`;
      context.pendingSnapshot = { usage: signature, identity, at: r.timestamp };
    }
  }
  if (!at || !Number.isFinite(Date.parse(at)) || !context.model || !usage) return null;
  const settings = provider === 'claude' ? context.settings?.[context.model] ?? null : null;
  const thinking = provider === 'claude' ? usage.output_tokens_details?.thinking_tokens : usage.reasoning_output_tokens;
  const thinkingTokens = typeof thinking === 'number' && Number.isFinite(thinking) && thinking >= 0 ? thinking : null;
  const hasThinking = thinkingTokens !== null ? thinkingTokens > 0 || explicitHasThinking === true : explicitHasThinking;
  const write1h = provider === 'claude' ? usage.cache_creation?.ephemeral_1h_input_tokens : undefined;
  const sessionPrefix = provider === 'antigravity' ? 'agy' : provider;
  const parentSessionId = context.parentSession && context.parentSession !== context.session ? `${sessionPrefix}:${context.parentSession}` : null;
  const resolvedKind: SessionKind | null = context.sessionKind ?? (parentSessionId ? 'subagent' : context.session ? 'root' : null);
  return {
    thinkingTokens, hasThinking,
    clientVersion: provider === 'claude' ? text(r.version) : context.version ?? null, settingsHash: settings ? requestSettingsHash(settings) : null,
    ...(settings ? { requestSettings: settings } : {}),
    at, requestId: `client-log:${provider}:${createHash('sha256').update(identity).digest('hex')}`,
    upstreamId, turnKey: context.turn ? `${sessionPrefix}:${context.turn}` : null, source: 'client-log', selectionId: null, provider, model: context.model,
    effectiveModel: null, reasoningEffort: context.effort ?? null, parentSessionId, sessionKind: resolvedKind,
    authIndex: context.authIndex ?? null, stream: true, failed: false, statusCode: null, error: null, latencyMs: null, ttftMs: null,
    inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens),
    cachedTokens: tokens(provider === 'claude' ? usage.cache_read_input_tokens : usage.cached_input_tokens),
    cacheWriteTokens: tokens(provider === 'claude' ? usage.cache_creation_input_tokens : usage.cache_write_input_tokens),
    cacheWrite1hTokens: typeof write1h === 'number' && Number.isFinite(write1h) && write1h >= 0 ? write1h : null,
    tier: provider === 'claude' && (usage.speed === 'fast' || usage.speed === 'standard') ? usage.speed : null,
    sessionId: context.session ? `${sessionPrefix}:${context.session}` : null,
    movedFrom: null, userAgent: null, client: context.client ?? null,
  };
}
