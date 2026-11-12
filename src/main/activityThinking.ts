import { localDay } from '@shared/activityCounts';
import { inScope, normalizeScope } from '@shared/activityScope';
import { currentRates, tokenCost } from '@shared/modelPrices';
import { CHANGE_MAX_REQUESTS, LIGHT_THINKING_MAX, MIN_RATIO_TURNS, QUESTION_MAX_REQUESTS, THINKING_BUCKETS, TURN_KINDS, TYPICAL_THINKING_MAX, settingKey, type Alternative, type ThinkingQuery, type ThinkingReport, type ThinkingSetting, type TurnKind } from '@shared/thinking';
import type { ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';
import { identityKey } from './usageLedger';

export interface OfferedModel { id: string; provider: string; created?: number | null }
type Request = ActivityEvent & { costUsd?: number };
export interface Turn { first: Request; requests: Request[] }
const EFFORTS = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
// Every provider offers medium; include it even without observed comparison turns.
const UNIVERSAL_COMPARISON_EFFORT = 'medium';
const DAYS_PER_WEEK = 7;
const MAX_MODEL_ALTERNATIVES = 3;
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2); return s.length ? s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2 : 0; };
export const setting = (e: Request): ThinkingSetting => ({ provider: e.provider, model: e.effectiveModel ?? e.model, effort: e.reasoningEffort! });
const cost = (e: Request) => e.costUsd ?? tokenCost(e.provider, e.effectiveModel ?? e.model, e.at, { ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 })?.usd ?? 0;
const counts = (e: Request) => ({ ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 });
// Subtracting identical prompt charges isolates output pricing, including tier and long-context rates.
const thinkingCost = (e: Request) => {
  const t = counts(e), model = e.effectiveModel ?? e.model;
  const full = tokenCost(e.provider, model, e.at, t);
  const visible = tokenCost(e.provider, model, e.at, { ...t, outputTokens: e.outputTokens - (e.thinkingTokens ?? 0) });
  return full && visible ? full.usd - visible.usd : 0;
};
export const kind = (t: Turn): TurnKind => {
  const requests = t.requests.filter((e) => e.sessionKind !== 'compaction');
  return requests.length > CHANGE_MAX_REQUESTS || requests.some((e) => e.sessionKind === 'subagent') ? 'long' : requests.length <= QUESTION_MAX_REQUESTS ? 'question' : 'change';
};
const thinking = (t: Turn) => sum(t.requests, (e) => e.thinkingTokens ?? 0);
const turnCost = (t: Turn) => sum(t.requests, cost);
const bucket = (t: Turn) => thinking(t) <= LIGHT_THINKING_MAX ? 'light' : thinking(t) <= TYPICAL_THINKING_MAX ? 'typical' : 'heavy';

export function group(requests: Request[]): { turns: Turn[]; excluded: Request[] } {
  const sessions = new Map<string, Request[]>();
  const excluded: Request[] = [];
  for (const e of requests) {
    if (!e.sessionId) { excluded.push(e); continue; }
    const list = sessions.get(e.sessionId) ?? [];
    list.push(e); sessions.set(e.sessionId, list);
  }
  const attached = (list: Request[]) => list.some((e) => e.sessionKind === 'subagent' || e.sessionKind === 'compaction' && e.parentSessionId);
  const roots = new Map<string, Turn[]>();
  const turns: Turn[] = [];
  for (const [id, list] of sessions) {
    if (attached(list)) continue;
    let active: Turn | undefined;
    for (const e of list) {
      if (!e.turnKey) { excluded.push(e); active = undefined; continue; }
      if (!active || active.first.turnKey !== e.turnKey) {
        active = { first: e, requests: [] }; turns.push(active);
        const own = roots.get(id) ?? []; own.push(active); roots.set(id, own);
      }
      active.requests.push(e);
    }
  }
  for (const [id, list] of sessions) {
    if (!attached(list)) continue;
    const seen = new Set([id]);
    let parent = list.find((e) => e.parentSessionId)?.parentSessionId;
    while (parent && !roots.has(parent) && !seen.has(parent)) {
      seen.add(parent); parent = sessions.get(parent)?.find((e) => e.parentSessionId)?.parentSessionId;
    }
    const active = parent ? roots.get(parent)?.findLast((t) => Date.parse(t.first.at) <= Date.parse(list[0]!.at)) : undefined;
    if (active) active.requests.push(...list); else excluded.push(...list);
  }
  return { turns, excluded };
}

/** Retained turns use their first root request's setting; scoped requests contribute their stored cost. */
export function thinkingActivity(db: Db, raw: Partial<ThinkingQuery> | undefined, models: OfferedModel[]): ThinkingReport | null {
  if (typeof raw?.from !== 'number' || typeof raw.to !== 'number' || !Number.isFinite(raw.from) || !Number.isFinite(raw.to) || raw.from > raw.to) return null;
  const q = { from: raw.from, to: raw.to, scope: normalizeScope(raw.scope) };
  const identity = db.prepare('SELECT event FROM usage_identities WHERE key = ? AND row_id = ?');
  const requests = (db.prepare("SELECT id, event FROM requests ORDER BY julianday(json_extract(event, '$.at')), id").all() as { id: number; event: string }[])
    .map((r) => {
      const event = JSON.parse(r.event) as Request;
      const ledger = identity.get(identityKey(event), r.id) as { event: string } | undefined;
      const stored = ledger ? JSON.parse(ledger.event) as Request : null;
      return { ...event, ...(stored?.costUsd !== undefined ? { costUsd: stored.costUsd } : {}) };
    });
  const { turns: all, excluded } = group(requests);
  const inTime = (e: Request) => Date.parse(e.at) >= q.from && Date.parse(e.at) <= q.to;
  const untracked = { requests: 0, costUsd: 0 };
  const omit = (e: Request) => { untracked.requests++; untracked.costUsd += cost(e); };
  for (const e of excluded) if (inTime(e) && inScope(q.scope, e)) omit(e);
  const turns: Turn[] = [];
  for (const t of all) {
    if (!inTime(t.first)) continue;
    const scoped = t.requests.filter((e) => inScope(q.scope, e));
    for (const e of scoped) if (!e.turnKey || !EFFORTS.includes(e.reasoningEffort ?? '') || !EFFORTS.includes(t.first.reasoningEffort ?? '')) omit(e);
    const tracked = scoped.filter((e) => e.turnKey && EFFORTS.includes(e.reasoningEffort ?? '') && EFFORTS.includes(t.first.reasoningEffort ?? ''));
    if (tracked.length) turns.push({ first: t.first, requests: tracked });
  }
  const days = [...new Set(turns.map((t) => localDay(Date.parse(t.first.at))))].sort();
  const factor = days.length ? DAYS_PER_WEEK / days.length : 0;
  const groups = new Map<string, Turn[]>();
  for (const t of turns) { const key = settingKey(setting(t.first)), own = groups.get(key) ?? []; own.push(t); groups.set(key, own); }
  const settings = [...groups.values()].map((own) => {
    const s = setting(own[0]!.first), total = sum(own, turnCost), tc = sum(own, (t) => sum(t.requests, thinkingCost));
    const observed = new Set(turns.filter((t) => t.first.provider === s.provider).map((t) => t.first.reasoningEffort));
    const lower = EFFORTS.slice(EFFORTS.indexOf(s.effort) + 1).filter((effort) => observed.has(effort) || effort === UNIVERSAL_COMPARISON_EFFORT);
    const ratios = new Map<string, number | null>();
    const ratio = (effort: string, k?: TurnKind): number | null => {
      const key = JSON.stringify([effort, k ?? null]);
      if (ratios.has(key)) return ratios.get(key)!;
      const measured = (t: Turn) => t.requests.every((e) => e.thinkingTokens != null);
      const a = own.filter((t) => measured(t) && (!k || kind(t) === k));
      const b = (groups.get(settingKey({ ...s, effort })) ?? []).filter((t) => measured(t) && (!k || kind(t) === k));
      const denominator = median(a.map(thinking));
      const value = a.length < MIN_RATIO_TURNS || b.length < MIN_RATIO_TURNS ? k ? ratio(effort) : null
        : denominator > 0 ? Math.min(median(b.map(thinking)) / denominator, 1) : null;
      ratios.set(key, value);
      return value;
    };
    const estimate = (t: Turn, effort: string) => {
      if (t.requests.some((e) => e.thinkingTokens == null || !currentRates(e.effectiveModel ?? e.model))) return null;
      const r = ratio(effort, kind(t));
      return r === null ? null : turnCost(t) - sum(t.requests.filter((e) => settingKey(setting(e)) === settingKey(s)), thinkingCost) * (1 - r);
    };
    const alternative = (target: ThinkingSetting, method: Alternative['method'], values: (number | null)[], reason: Alternative['reason'] = 'not-enough-data'): Alternative => {
      if (values.some((v) => v === null)) return { setting: target, method, costUsdPerWeek: null, savingUsdPerWeek: null, savingShare: null, medianTurnCostUsd: null, reason };
      const costs = values as number[], estimated = sum(costs, (v) => v);
      return { setting: target, method, costUsdPerWeek: estimated * factor, savingUsdPerWeek: (total - estimated) * factor, savingShare: total ? (total - estimated) / total : 0, medianTurnCostUsd: median(costs), reason: null };
    };
    const alternatives = lower.map((effort) => alternative({ ...s, effort }, 'effort-ratio', own.map((t) => estimate(t, effort)), currentRates(s.model) ? 'not-enough-data' : 'unpriced'));
    const base = currentRates(s.model);
    const candidates = [...new Map(models.filter((m) => m.provider === s.provider && m.id !== s.model).map((m) => [m.id, m])).values()]
      .filter((m) => { const r = currentRates(m.id); return base && r && r.input < base.input && r.output < base.output; });
    const kept = candidates.filter((m) => !candidates.some((other) => {
      const a = currentRates(m.id)!, b = currentRates(other.id)!;
      return m.created != null && other.created != null && other.created > m.created && b.input <= a.input && b.output <= a.output;
    })).sort((a, b) => currentRates(b.id)!.output - currentRates(a.id)!.output).slice(0, MAX_MODEL_ALTERNATIVES);
    for (const m of kept) alternatives.push(alternative({ ...s, model: m.id }, 'reprice', own.map((t) => {
      let estimate = turnCost(t);
      for (const e of t.requests) {
        if (settingKey(setting(e)) !== settingKey(s)) continue;
        const priced = tokenCost(e.provider, m.id, e.at, counts(e));
        if (!priced) return null;
        estimate += priced.usd - cost(e);
      }
      return estimate;
    }), 'unpriced'));
    const mixedEffort = lower.find((effort) => ratio(effort, 'question') !== null && ratio(effort, 'change') !== null && own.every((t) => kind(t) === 'long' || estimate(t, effort) !== null));
    if (mixedEffort) alternatives.push(alternative({ ...s, effort: mixedEffort }, 'mixed', own.map((t) => kind(t) === 'long' ? turnCost(t) : estimate(t, mixedEffort))));
    return {
      setting: s, turns: own.length, costUsd: total, costUsdPerWeek: total * factor, thinkingCostUsd: tc, thinkingShare: total ? tc / total : 0, medianTurnCostUsd: median(own.map(turnCost)),
      buckets: THINKING_BUCKETS.map((b) => { const selected = own.filter((t) => bucket(t) === b), thinkingCostUsd = sum(selected, (t) => sum(t.requests, thinkingCost)); return { bucket: b, turns: selected.length, turnShare: selected.length / own.length, thinkingCostUsd, thinkingCostShare: tc ? thinkingCostUsd / tc : 0 }; }),
      kinds: TURN_KINDS.map((k) => {
        const selected = own.filter((t) => kind(t) === k), costUsd = sum(selected, turnCost);
        const effort = lower.find((e) => selected.length > 0 && selected.every((t) => estimate(t, e) !== null));
        return { kind: k, turns: selected.length, costUsd, costShare: total ? costUsd / total : 0, thinkingShare: costUsd ? sum(selected, (t) => sum(t.requests, thinkingCost)) / costUsd : 0,
          lowerEffortSavingUsdPerWeek: effort ? sum(selected, (t) => turnCost(t) - estimate(t, effort)!) * factor : null };
      }), alternatives,
    };
  }).sort((a, b) => b.costUsd - a.costUsd);
  return { coveredFrom: days[0] ?? null, coveredTo: days.at(-1) ?? null, coveredDays: days.length, settings, untracked };
}
