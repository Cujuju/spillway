import { randomUUID } from 'node:crypto';
import { inScope, normalizeScope } from '@shared/activityScope';
import type { ArchiveDetail } from '@shared/archive';
import { promptTokens, tokenCost } from '@shared/modelPrices';
import { settingKey, TURN_KINDS, type TurnKind, type ThinkingSetting } from '@shared/thinking';
import { TEST_TURN_CHOICES, type TestPlan, type TestPlanRequest } from '@shared/thinkingTest';
import type { ActivityEvent } from '@shared/types';
import { group, kind, setting, type Turn } from './activityThinking';
import type { Db } from './activityDb';
import type { ArchiveStore } from './archiveStore';
import { object } from './evalCaseCodec';
import { assembleResponse, nextMove, TEST_ROUTES } from './thinkingTestCodec';

// Same approval lifetime as eval replay previews.
export const TEST_PLAN_TTL_MS = 5 * 60_000;
// Bounded judge context: request tail and two next moves, plus instruction overhead.
export const JUDGE_CONTEXT_CHARS = 6000;
export const JUDGE_INPUT_TOKENS = 6000;
export const JUDGE_OUTPUT_TOKENS = 256;
// The fork maps none to disabled or the model's lowest supported effort (internal/thinking/validate.go).
export const judgeSetting = (s: ThinkingSetting): ThinkingSetting => ({ ...s, effort: 'none' });
export interface TestSample { turnAt: string; traceId: string | null; kind: TurnKind; route: string; body: Record<string, unknown>; response: string; event: ActivityEvent }
export interface PreparedTest { plan: TestPlan; samples: TestSample[]; shares: Record<TurnKind, number> }
export function capturedRequest(d: ArchiveDetail | null): { route: string; body: Record<string, unknown>; response: string } {
  if (!d || !d.request || !d.response) throw new Error('request not captured (turn on request capture)');
  if (d.format === 'websocket') throw new Error('WebSocket turn depends on earlier server state');
  if (d.state !== 'complete' || d.requestCut || d.responseCut) throw new Error('body incomplete');
  if (d.method !== 'POST' || !TEST_ROUTES.includes(d.path)) throw new Error('unsupported request route');
  if ((!d.requestDecoded && !['', 'identity'].includes(d.requestEncoding)) || (!d.responseDecoded && !['', 'identity'].includes(d.responseEncoding))) throw new Error('body encoding unsupported');
  let body: unknown;
  try { body = JSON.parse(d.request); } catch { throw new Error('body incomplete'); }
  if (!object(body) || typeof body.model !== 'string' || !body.model) throw new Error('body incomplete');
  if (Array.isArray(body.input) && body.input.some((item) => object(item) && item.type === 'item_reference')) throw new Error('request depends on earlier server state');
  if (Array.isArray(body.tools) && body.tools.some((tool) => !object(tool) || typeof tool.type === 'string' && !['function', 'custom'].includes(tool.type) && !(d.path === '/v1/messages' && /^(bash|text_editor|computer)_/.test(tool.type)))) throw new Error('server-executed tools cannot be replayed');
  if (body.previous_response_id || body.conversation) throw new Error('request depends on earlier server state');
  if (d.path.includes('responses') ? !body.input : !Array.isArray(body.messages)) throw new Error('body incomplete');
  try { nextMove(assembleResponse(d.response)); } catch { throw new Error('response incomplete'); }
  return { route: d.path, body, response: d.response };
}
export function stratify<T extends { kind: TurnKind }>(items: T[], count: number, random = Math.random): T[] {
  const pools = TURN_KINDS.map((kind) => items.filter((x) => x.kind === kind));
  // Fisher-Yates gives every retained turn equal probability within its kind.
  for (const pool of pools) for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
  const selected: T[] = [];
  while (selected.length < count && pools.some((p) => p.length)) for (const pool of pools) { if (pool.length && selected.length < count) selected.push(pool.pop()!); }
  return selected;
}
export function coldCost(s: ThinkingSetting, inputTokens: number, outputTokens: number): number {
  const priced = tokenCost(s.provider, s.model, Date.now(), { inputTokens, outputTokens, cachedTokens: 0, cacheWriteTokens: 0 });
  if (!priced) throw new Error(`No list price for ${s.model}`); return priced.usd;
}
export function prepareTest(db: Db, archive: Pick<ArchiveStore, 'captureMetadata' | 'detail'>, req: TestPlanRequest): PreparedTest {
  if (!req || !TEST_TURN_CHOICES.some((n) => n === req.turns) || !req.alternatives.length || !Number.isFinite(req.query.from) || !Number.isFinite(req.query.to) || req.query.from > req.query.to) throw new Error('Invalid thinking test request');
  if (req.alternatives.some((a) => a.provider !== req.setting.provider) || new Set(req.alternatives.map(settingKey)).size !== req.alternatives.length) throw new Error('Alternatives must be distinct settings from the same provider');
  const events = (db.prepare("SELECT event FROM requests ORDER BY julianday(json_extract(event, '$.at')), id").all() as { event: string }[]).map((r) => JSON.parse(r.event) as ActivityEvent);
  const scope = normalizeScope(req.query.scope);
  const turns = group(events).turns.filter((t) => Date.parse(t.first.at) >= req.query.from && Date.parse(t.first.at) <= req.query.to && settingKey(setting(t.first)) === settingKey(req.setting) && t.requests.some((e) => inScope(scope, e)));
  const available: { turn: Turn; kind: TurnKind; candidates: ActivityEvent[] }[] = [], skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  for (const t of turns) {
    const candidates: ActivityEvent[] = []; let reason = 'request not captured (turn on request capture)';
    for (const e of t.requests) {
      if (e.sessionKind === 'subagent' || e.sessionId !== t.first.sessionId || !inScope(scope, e) || settingKey(setting(e)) !== settingKey(req.setting)) continue;
      if (e.failed || e.sessionKind === 'compaction') { reason = e.failed ? 'failed request' : 'compaction request'; continue; }
      const metadata = e.traceId ? archive.captureMetadata(e.traceId) : null;
      if (!metadata || !metadata.bytes) { reason = 'request not captured (turn on request capture)'; continue; }
      if (metadata.format === 'websocket') { reason = 'WebSocket turn depends on earlier server state'; continue; }
      if (metadata.state !== 'complete') { reason = 'body incomplete'; continue; }
      if (metadata.method !== 'POST' || !TEST_ROUTES.includes(metadata.path)) { reason = 'unsupported request route'; continue; }
      candidates.push(e);
    }
    if (candidates.length) available.push({ turn: t, kind: kind(t), candidates });
    else skip(reason);
  }
  const samples: TestSample[] = [];
  let replayableTurns = available.length;
  // Randomize each kind once; failed validation consumes a candidate, never a sample slot.
  const pools = TURN_KINDS.map((kind) => stratify(available.filter((t) => t.kind === kind), available.length));
  while (samples.length < req.turns && pools.some((pool) => pool.length)) {
    for (const pool of pools) {
      if (samples.length >= req.turns) break;
      while (pool.length) {
        const candidate = pool.pop()!;
        let sample: TestSample | undefined, reason = 'body incomplete';
        for (const e of stratify(candidate.candidates.map((event) => ({ event, kind: candidate.kind })), candidate.candidates.length)) {
          try { sample = { ...capturedRequest(archive.detail(e.event.traceId!)), turnAt: candidate.turn.first.at, traceId: e.event.traceId!, kind: candidate.kind, event: e.event }; break; }
          catch (error) { reason = (error as Error).message; }
        }
        if (sample) { samples.push(sample); break; }
        replayableTurns--; skip(reason);
      }
    }
  }
  const shares = Object.fromEntries(TURN_KINDS.map((k) => [k, turns.length ? turns.filter((t) => kind(t) === k).length / turns.length : 0])) as Record<TurnKind, number>;
  const estimatedCostUsd = samples.reduce((total, s) => total + req.alternatives.reduce((n, a) => n + coldCost(a, promptTokens(s.event.provider, s.event), s.event.outputTokens) + coldCost(judgeSetting(req.setting), JUDGE_INPUT_TOKENS, JUDGE_OUTPUT_TOKENS), 0), 0);
  return { samples, shares, plan: { id: randomUUID(), setting: req.setting, alternatives: req.alternatives, sampled: TURN_KINDS.map((kind) => ({ kind, turns: samples.filter((s) => s.kind === kind).length })), eligibleTurns: turns.length, replayableTurns, skipped: [...skipped].map(([reason, turns]) => ({ reason, turns })).sort((a, b) => b.turns - a.turns), estimatedCostUsd, expiresAt: new Date(Date.now() + TEST_PLAN_TTL_MS).toISOString() } };
}
