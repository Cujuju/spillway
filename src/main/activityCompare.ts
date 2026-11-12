import { addCounts, emptyCounts, localDay, localHourStart } from '@shared/activityCounts';
import { comboKey, taskStats, type CompareQuery, type CompareReport, type CompareRow, type DaySpan, type TaskSums } from '@shared/activityCompare';
import { inScope, normalizeScope } from '@shared/activityScope';
import { promptTokens, tokenCost } from '@shared/modelPrices';
import type { ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import type { ActivityTotal } from './activityTotals';
import { scopeClause } from './activityStore';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest parent chain followed to a root; deeper or cyclic chains stop at the last session reached. */
const MAX_PARENT_DEPTH = 64;

const midnight = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y!, m! - 1, d!).getTime(); };
/** Local calendar days from `from` through `to`, both included; rounding absorbs DST's 23- and 25-hour days. */
const daysThrough = (from: string, to: string) => Math.round((midnight(to) - midnight(from)) / DAY_MS) + 1;
const clip = (from: string | null, range: DaySpan): DaySpan | null => {
  if (from === null || from > range.to) return null;
  const start = from > range.from ? from : range.from;
  return { from: start, to: range.to, days: daysThrough(start, range.to) };
};

/** Renderer input arrives untyped over IPC. */
function normalizeQuery(raw: Partial<CompareQuery> | undefined): CompareQuery | null {
  const from = raw?.from, to = raw?.to;
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  return { scope: normalizeScope(raw?.scope), from, to };
}

/** Each combination's whole-range totals and the tasks in retained requests; see CompareReport. */
export function compareActivity(db: Db, totals: Iterable<ActivityTotal>, raw: Partial<CompareQuery> | undefined, now: number): CompareReport | null {
  const q = normalizeQuery(raw);
  if (!q) return null;
  const to = Math.min(q.to, now);
  const range: DaySpan = { from: localDay(q.from), to: localDay(to), days: daysThrough(localDay(q.from), localDay(to)) };
  const rows = new Map<string, CompareRow>();
  const row = (model: string, effort: string) => {
    const key = comboKey({ model, effort });
    if (!rows.has(key)) rows.set(key, { key, model, effort, whole: { ...emptyCounts(), promptTokens: 0 }, tasks: null, asSubagentCostUsd: 0 });
    return rows.get(key)!;
  };
  const unknown = new Map<string, CompareReport['unknownEffort']['models'][number]>();
  let sharesFrom: string | null = null;
  for (const t of totals) {
    if (t.detailRequests > 0 && (sharesFrom === null || t.day < sharesFrom)) sharesFrom = t.day;
    const start = t.start ?? midnight(t.day);
    if (start < q.from || start > q.to || !inScope(q.scope, t)) continue;
    const model = t.effectiveModel ?? t.model;
    if (!t.reasoningEffort) {
      const u = unknown.get(model) ?? { model, requests: 0, costUsd: 0, unpricedRequests: 0 };
      u.requests += t.requests;
      u.costUsd += t.costUsd;
      u.unpricedRequests += t.unpricedRequests;
      unknown.set(model, u);
      continue;
    }
    const r = row(model, t.reasoningEffort);
    addCounts(r.whole, t);
    r.whole.promptTokens += promptTokens(t.provider, t);
  }
  const oldest = (db.prepare('SELECT min(day) AS day FROM requests').get() as { day: string | null }).day;
  const retained = clip(oldest, range);
  if (retained) addTasks(db, q, retained, rows, row);
  const models = [...unknown.values()].filter((u) => u.requests > 0).sort((a, b) => b.costUsd - a.costUsd);
  return {
    combos: [...rows.values()].sort((a, b) => b.whole.costUsd - a.whole.costUsd || b.whole.requests - a.whole.requests),
    range, retained, shares: clip(sharesFrom, range),
    unknownEffort: { requests: models.reduce((n, u) => n + u.requests, 0), costUsd: models.reduce((n, u) => n + u.costUsd, 0), unpricedRequests: models.reduce((n, u) => n + u.unpricedRequests, 0), models },
  };
}

type Request = ActivityEvent & { costUsd?: number };
interface Task extends TaskSums { rootAt: string | null; firstAt: string }

/** Groups retained requests into tasks: a root session with its subagent, fork and compaction sessions; a sessionless request is its own task. */
function addTasks(db: Db, q: CompareQuery, span: DaySpan, rows: Map<string, CompareRow>, row: (model: string, effort: string) => CompareRow): void {
  const clause = scopeClause(q.scope);
  const sql = `SELECT id, event FROM requests WHERE day >= ? AND day <= ?${clause ? ` AND ${clause.sql}` : ''}`;
  const requests = (db.prepare(sql).all(span.from, span.to, ...(clause?.params ?? [])) as { id: number; event: string }[])
    .map((r) => ({ id: r.id, e: JSON.parse(r.event) as Request }))
    .filter(({ e }) => { const hour = localHourStart(Date.parse(e.at)); return hour >= q.from && hour <= q.to; });
  const parents = new Map<string, string>();
  for (const { e } of requests) if (e.sessionId && e.parentSessionId && !parents.has(e.sessionId)) parents.set(e.sessionId, e.parentSessionId);
  const rootOf = (session: string) => {
    let id = session;
    for (let depth = 0; depth < MAX_PARENT_DEPTH && parents.has(id) && parents.get(id) !== session; depth++) id = parents.get(id)!;
    return id;
  };
  const tasks = new Map<string, Task>();
  for (const { id, e } of requests) {
    if (!e.reasoningEffort) continue;
    const model = e.effectiveModel ?? e.model;
    const combo = row(model, e.reasoningEffort).key;
    const root = e.sessionId ? rootOf(e.sessionId) : null;
    const taskKey = root ? `session:${root}` : e.traceId ? `trace:${e.traceId}` : `attempt:${id}`;
    const task = tasks.get(taskKey) ?? { combo, rootAt: null, firstAt: e.at, costUsd: 0, tokens: 0, requests: 0, byCombo: new Map() };
    tasks.set(taskKey, task);
    // Failed requests count too; their cost is usually zero.
    const cost = e.costUsd ?? tokenCost(e.provider, model, e.at, { ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 })?.usd ?? 0;
    task.costUsd += cost;
    task.tokens += promptTokens(e.provider, { ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 }) + e.outputTokens;
    task.requests += 1;
    task.byCombo.set(combo, (task.byCombo.get(combo) ?? 0) + cost);
    // A task counts under its root session's first combination, else its first request's.
    const isRoot = root !== null && e.sessionId === root;
    if (isRoot ? task.rootAt === null || e.at < task.rootAt : task.rootAt === null && e.at < task.firstAt) task.combo = combo;
    if (isRoot && (task.rootAt === null || e.at < task.rootAt)) task.rootAt = e.at;
    if (e.at < task.firstAt) task.firstAt = e.at;
  }
  const started = new Map<string, Task[]>();
  for (const task of tasks.values()) {
    started.set(task.combo, [...started.get(task.combo) ?? [], task]);
    for (const [combo, cost] of task.byCombo) if (combo !== task.combo) rows.get(combo)!.asSubagentCostUsd += cost;
  }
  for (const [combo, list] of started) rows.get(combo)!.tasks = taskStats(combo, list);
}
