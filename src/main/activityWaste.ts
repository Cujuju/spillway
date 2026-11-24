import { localDay } from '@shared/activityCounts';
import { quantile, type DaySpan } from '@shared/activityCompare';
import { normalizeScope } from '@shared/activityScope';
import {
  type ColdMissSummary,
  type CostAnatomy,
  type PromptBucketId,
  type PromptBucketStat,
  type TopWasteSession,
  type WasteDriverTag,
  type WasteQuery,
  type WasteReport,
} from '@shared/activityWaste';
import { promptTokens, tokenCostBreakdown } from '@shared/modelPrices';
import type { ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { scopeClause } from './activityStore';
import { dayWindow } from './retainedTurns';

const DAY_MS = 24 * 60 * 60 * 1000;
const P90 = 0.9;
const PROMPT_100K = 100_000;
const PROMPT_200K = 200_000;
const PROMPT_350K = 350_000;
/** Large prompt cutoff where a cold cache miss meaningfully burns quota. */
const COLD_MISS_MIN_PROMPT = 80_000;
/** Minimum uncached+written tokens on a cold miss to separate from normal prompt growth. */
const COLD_MISS_MIN_COLD_TOKENS = 50_000;
/** Cache hit ceiling for a cold cache miss on a large prompt. */
const COLD_MISS_MAX_CACHE_HIT = 0.7;
/** Standard provider prompt-cache TTL (5 minutes); gaps beyond this classify as idle wakeups. */
const IDLE_CACHE_TTL_MS = 5 * 60_000;
/** Sessions with large prompts and cache hit below 85% get a low-cache driver tag. */
const LOW_CACHE_THRESHOLD = 0.85;
const TOP_SESSIONS_LIMIT = 15;
/** Keeps SQLite IN-clause parameter counts well below SQLITE_MAX_VARIABLE_NUMBER. */
const SESSION_QUERY_CHUNK = 500;

const BUCKET_DEFS: readonly { id: PromptBucketId; label: string }[] = [
  { id: 'under100k', label: '≤ 100K' },
  { id: '100kTo200k', label: '100K – 200K' },
  { id: '200kTo350k', label: '200K – 350K' },
  { id: 'over350k', label: '> 350K' },
];

const midnight = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!).getTime(); };
const daysThrough = (from: string, to: string) => Math.round((midnight(to) - midnight(from)) / DAY_MS) + 1;

function clip(from: string | null, range: DaySpan): DaySpan | null {
  if (from === null || from > range.to) return null;
  const start = from > range.from ? from : range.from;
  return { from: start, to: range.to, days: daysThrough(start, range.to) };
}

function normalizeQuery(raw: Partial<WasteQuery> | undefined): WasteQuery | null {
  const from = raw?.from, to = raw?.to;
  if (typeof to !== 'number' || !Number.isFinite(to)) return null;
  if (from !== null && (typeof from !== 'number' || !Number.isFinite(from) || from > to)) return null;
  return { scope: normalizeScope(raw?.scope), from, to };
}

function bucketFor(prompt: number): PromptBucketId {
  if (prompt <= PROMPT_100K) return 'under100k';
  if (prompt <= PROMPT_200K) return '100kTo200k';
  if (prompt <= PROMPT_350K) return '200kTo350k';
  return 'over350k';
}

interface SessionPredecessor {
  atMs: number;
  model: string;
  effort: string | null;
}

interface TimelineRow {
  id: number;
  sessionId: string;
  at: string;
  model: string;
  effort: string | null;
}

/** Resolves each in-range row's true preceding retained request in the same session, unaffected by range/scope cuts. */
function sessionPredecessors(db: Db, sessionIds: readonly string[], to: number): Map<number, SessionPredecessor> {
  const bySession = new Map<string, { id: number; atMs: number; model: string; effort: string | null }[]>();
  for (let i = 0; i < sessionIds.length; i += SESSION_QUERY_CHUNK) {
    const chunk = sessionIds.slice(i, i + SESSION_QUERY_CHUNK);
    const sql = `SELECT id, json_extract(event, '$.sessionId') AS sessionId, json_extract(event, '$.at') AS at,
      coalesce(json_extract(event, '$.effectiveModel'), json_extract(event, '$.model')) AS model,
      json_extract(event, '$.reasoningEffort') AS effort
      FROM requests WHERE json_extract(event, '$.sessionId') IN (${chunk.map(() => '?').join(', ')})`;
    for (const row of db.prepare(sql).all(...chunk) as TimelineRow[]) {
      const atMs = Date.parse(row.at);
      if (!Number.isFinite(atMs) || atMs > to) continue;
      let list = bySession.get(row.sessionId);
      if (!list) { list = []; bySession.set(row.sessionId, list); }
      list.push({ id: row.id, atMs, model: row.model, effort: row.effort ?? null });
    }
  }
  const pred = new Map<number, SessionPredecessor>();
  for (const list of bySession.values()) {
    list.sort((a, b) => a.atMs - b.atMs || a.id - b.id);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      pred.set(list[i]!.id, { atMs: prev.atMs, model: prev.model, effort: prev.effort });
    }
  }
  return pred;
}

interface ModelCombo {
  provider: string;
  model: string;
  effort: string | null;
  cost: number;
  requests: number;
}

interface SessionAcc {
  sessionId: string;
  requests: number;
  costUsd: number;
  promptSum: number;
  cachedSum: number;
  maxPromptTokens: number;
  coldMissUsd: number;
  idleWakes: number;
  midTurnMisses: number;
  effortSwitches: number;
  modelSwitches: number;
  firstAt: string;
  lastAt: string;
  modelCost: Map<string, ModelCombo>;
}

function sessionDrivers(s: SessionAcc, cacheHitRate: number): WasteDriverTag[] {
  const drivers: WasteDriverTag[] = [];
  if (s.maxPromptTokens > PROMPT_350K) drivers.push('over350k');
  else if (s.maxPromptTokens > PROMPT_200K) drivers.push('over200k');
  if (s.idleWakes > 0) drivers.push('idleWakes');
  if (s.midTurnMisses > 0) drivers.push('midTurnMisses');
  if (s.effortSwitches > 0) drivers.push('effortSwitch');
  if (s.modelSwitches > 0) drivers.push('modelSwitch');
  if (s.maxPromptTokens > PROMPT_100K && cacheHitRate < LOW_CACHE_THRESHOLD) drivers.push('lowCache');
  return drivers;
}

/** Summarizes prompt bloat, cost anatomy, cold cache misses, and top burn sessions from retained requests. */
export function wasteActivity(db: Db, raw: Partial<WasteQuery> | undefined, now: number): WasteReport | null {
  const q = normalizeQuery(raw);
  if (!q) return null;
  const to = Math.min(q.to, now);
  const toDay = localDay(to);
  const oldest = (db.prepare('SELECT min(day) AS day FROM requests').get() as { day: string | null }).day;

  const buckets = new Map<PromptBucketId, { requests: number; costUsd: number }>(
    BUCKET_DEFS.map((b) => [b.id, { requests: 0, costUsd: 0 }]),
  );
  const anatomy: CostAnatomy = { uncachedInputUsd: 0, cacheWriteUsd: 0, cacheReadUsd: 0, outputUsd: 0 };
  const coldMisses: ColdMissSummary = {
    total: { requests: 0, costUsd: 0 },
    afterIdle: { requests: 0, costUsd: 0 },
    midTurn: { requests: 0, costUsd: 0 },
    unclassified: { requests: 0, costUsd: 0 },
    effortSwitches: 0,
    modelSwitches: 0,
  };

  let requests = 0, pricedRequests = 0, unpricedRequests = 0, failedRequests = 0;
  let totalCostUsd = 0, promptSum = 0;
  const prompts: number[] = [];
  const sessions = new Map<string, SessionAcc>();
  let earliestEligibleDay: string | null = null;

  if (oldest !== null) {
    const clause = scopeClause(q.scope);
    let rawRows: { id: number; event: string }[];
    if (q.from === null) {
      const upperDay = dayWindow(to, to).to;
      const sql = `SELECT id, event FROM requests WHERE day <= ?${clause ? ` AND ${clause.sql}` : ''}`;
      rawRows = db.prepare(sql).all(upperDay, ...(clause?.params ?? [])) as { id: number; event: string }[];
    } else {
      // Bound stored day by Earth's UTC-12..UTC+14 span so requests_by_day serves the range without dropping timezone-shifted rows.
      const win = dayWindow(q.from, to);
      const sql = `SELECT id, event FROM requests WHERE day BETWEEN ? AND ?${clause ? ` AND ${clause.sql}` : ''}`;
      rawRows = db.prepare(sql).all(win.from, win.to, ...(clause?.params ?? [])) as { id: number; event: string }[];
    }
    const rows = rawRows
      .map((r) => { const e = JSON.parse(r.event) as ActivityEvent; return { id: r.id, atMs: Date.parse(e.at), e }; })
      .filter((r) => Number.isFinite(r.atMs) && (q.from === null || r.atMs >= q.from) && r.atMs <= to)
      .sort((a, b) => a.atMs - b.atMs || a.id - b.id);

    if (rows.length > 0) earliestEligibleDay = localDay(rows[0]!.atMs);
    const sessionIds = [...new Set(rows.flatMap((r) => (r.e.sessionId ? [r.e.sessionId] : [])))];
    const predecessors = sessionIds.length > 0 ? sessionPredecessors(db, sessionIds, to) : new Map<number, SessionPredecessor>();

    for (const { id, atMs, e } of rows) {
      requests += 1;
      if (e.failed) failedRequests += 1;
      const model = e.effectiveModel ?? e.model;
      const prompt = promptTokens(e.provider, { ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 });
      const cached = Math.min(prompt, Math.max(0, e.cachedTokens ?? 0));
      const parts = tokenCostBreakdown(e.provider, model, e.at, { ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 });
      const usd = parts?.usd ?? 0;
      if (parts) {
        pricedRequests += 1;
        totalCostUsd += usd;
        anatomy.uncachedInputUsd += parts.uncachedInputUsd;
        anatomy.cacheWriteUsd += parts.cacheWriteUsd;
        anatomy.cacheReadUsd += parts.cacheReadUsd;
        anatomy.outputUsd += parts.outputUsd;
      } else {
        unpricedRequests += 1;
      }
      promptSum += prompt;
      prompts.push(prompt);
      const b = buckets.get(bucketFor(prompt))!;
      b.requests += 1;
      b.costUsd += usd;

      let sess: SessionAcc | undefined;
      if (e.sessionId) {
        sess = sessions.get(e.sessionId);
        if (!sess) {
          sess = {
            sessionId: e.sessionId, requests: 0, costUsd: 0, promptSum: 0, cachedSum: 0, maxPromptTokens: 0,
            coldMissUsd: 0, idleWakes: 0, midTurnMisses: 0, effortSwitches: 0, modelSwitches: 0,
            firstAt: e.at, lastAt: e.at, modelCost: new Map(),
          };
          sessions.set(e.sessionId, sess);
        } else {
          sess.lastAt = e.at;
        }
      }

      const pred = predecessors.get(id);
      if (pred) {
        if (model !== pred.model) {
          coldMisses.modelSwitches += 1;
          if (sess) sess.modelSwitches += 1;
        } else if (pred.effort && e.reasoningEffort && e.reasoningEffort !== pred.effort) {
          coldMisses.effortSwitches += 1;
          if (sess) sess.effortSwitches += 1;
        }
      }

      const coldTokens = Math.max(0, prompt - cached);
      const cacheHit = prompt > 0 ? cached / prompt : 1;
      const isColdMiss = prompt > COLD_MISS_MIN_PROMPT && coldTokens > COLD_MISS_MIN_COLD_TOKENS && cacheHit < COLD_MISS_MAX_CACHE_HIT;
      if (isColdMiss) {
        const coldUsd = parts ? parts.uncachedInputUsd + parts.cacheWriteUsd : 0;
        coldMisses.total.requests += 1;
        coldMisses.total.costUsd += coldUsd;
        if (!pred) {
          coldMisses.unclassified.requests += 1;
          coldMisses.unclassified.costUsd += coldUsd;
        } else if (atMs - pred.atMs > IDLE_CACHE_TTL_MS) {
          coldMisses.afterIdle.requests += 1;
          coldMisses.afterIdle.costUsd += coldUsd;
          if (sess) sess.idleWakes += 1;
        } else {
          coldMisses.midTurn.requests += 1;
          coldMisses.midTurn.costUsd += coldUsd;
          if (sess) sess.midTurnMisses += 1;
        }
        if (sess) sess.coldMissUsd += coldUsd;
      }

      if (sess) {
        sess.requests += 1;
        sess.costUsd += usd;
        sess.promptSum += prompt;
        sess.cachedSum += cached;
        if (prompt > sess.maxPromptTokens) sess.maxPromptTokens = prompt;
        const effort = e.reasoningEffort ?? null;
        const comboKey = `${e.provider}\0${model}\0${effort ?? ''}`;
        const mc = sess.modelCost.get(comboKey) ?? { provider: e.provider, model, effort, cost: 0, requests: 0 };
        mc.cost += usd;
        mc.requests += 1;
        sess.modelCost.set(comboKey, mc);
      }
    }
  }

  prompts.sort((a, b) => a - b);
  const promptBuckets: PromptBucketStat[] = BUCKET_DEFS.map(({ id, label }) => {
    const b = buckets.get(id)!;
    return { id, label, requests: b.requests, costUsd: b.costUsd, share: totalCostUsd > 0 ? b.costUsd / totalCostUsd : 0 };
  });
  const over200kCostUsd = buckets.get('200kTo350k')!.costUsd + buckets.get('over350k')!.costUsd;

  const topSessions: TopWasteSession[] = [...sessions.values()]
    .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests)
    .slice(0, TOP_SESSIONS_LIMIT)
    .map((s) => {
      const primary = [...s.modelCost.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests)[0]!;
      const cacheHitRate = s.promptSum > 0 ? s.cachedSum / s.promptSum : 0;
      return {
        sessionId: s.sessionId,
        provider: primary.provider,
        model: primary.model,
        effort: primary.effort,
        requests: s.requests,
        costUsd: s.costUsd,
        maxPromptTokens: s.maxPromptTokens,
        avgPromptTokens: Math.round(s.promptSum / s.requests),
        cacheHitRate,
        coldMissUsd: s.coldMissUsd,
        idleWakes: s.idleWakes,
        midTurnMisses: s.midTurnMisses,
        effortSwitches: s.effortSwitches,
        modelSwitches: s.modelSwitches,
        drivers: sessionDrivers(s, cacheHitRate),
        firstAt: s.firstAt,
        lastAt: s.lastAt,
      };
    });

  const fromDay = q.from === null
    ? (earliestEligibleDay ?? (oldest !== null && oldest <= toDay ? oldest : toDay))
    : localDay(q.from);
  const range: DaySpan = { from: fromDay, to: toDay, days: daysThrough(fromDay, toDay) };
  const effectiveOldest = earliestEligibleDay !== null && (oldest === null || earliestEligibleDay < oldest) ? earliestEligibleDay : oldest;
  const retained = clip(effectiveOldest, range);

  return {
    range,
    retained,
    requests,
    pricedRequests,
    unpricedRequests,
    failedRequests,
    totalCostUsd,
    avgPromptTokens: requests > 0 ? Math.round(promptSum / requests) : 0,
    p90PromptTokens: prompts.length > 0 ? Math.round(quantile(prompts, P90)) : 0,
    over200kCostUsd,
    over200kShare: totalCostUsd > 0 ? over200kCostUsd / totalCostUsd : 0,
    anatomy,
    promptBuckets,
    coldMisses,
    topSessions,
  };
}
