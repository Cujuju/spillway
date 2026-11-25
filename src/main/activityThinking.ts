import { localDay } from '@shared/activityCounts';
import { inScope, normalizeScope } from '@shared/activityScope';
import { currentRates, tokenCost } from '@shared/modelPrices';
import { CHANGE_MAX_REQUESTS, LIGHT_THINKING_MAX, MIN_RATIO_TURNS, QUESTION_MAX_REQUESTS, THINKING_BUCKETS, TURN_KINDS, TYPICAL_THINKING_MAX, settingKey, type Alternative, type ThinkingQuery, type ThinkingReport, type ThinkingSetting, type TurnKind } from '@shared/thinking';
import type { Db } from './activityDb';
import { loadRetainedTurns, measureTurnSteps, scopedTurnRequests, type RetainedTurns, type Request, type Turn } from './retainedTurns';

export interface OfferedModel { id: string; provider: string; created?: number | null }
const EFFORTS = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
// Every provider offers medium; include it even without observed comparison turns.
const UNIVERSAL_COMPARISON_EFFORT = 'medium';
const DAYS_PER_WEEK = 7;
const MAX_MODEL_ALTERNATIVES = 3;
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
const mean = (xs: number[]) => (xs.length ? sum(xs, (x) => x) / xs.length : 0);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2); return s.length ? s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2 : 0; };
export const setting = (e: Request): ThinkingSetting => ({ provider: e.provider, model: e.effectiveModel ?? e.model, effort: e.reasoningEffort! });
const sameSetting = (a: Request, b: Request) => a.provider === b.provider && (a.effectiveModel ?? a.model) === (b.effectiveModel ?? b.model) && a.reasoningEffort === b.reasoningEffort;
// Requests recorded before cache writes were counted have none; the rest price as they are, uncopied.
const counts = (e: Request) => (e.cacheWriteTokens == null ? { ...e, cacheWriteTokens: 0 } : e);
const cost = (e: Request) => e.costUsd ?? tokenCost(e.provider, e.effectiveModel ?? e.model, e.at, counts(e))?.usd ?? 0;
// List prices are compiled in, so a request's thinking cost holds for as long as its object does.
const thinkingCosts = new WeakMap<Request, number>();
// Subtracting identical prompt charges isolates output pricing, including tier and long-context rates.
const thinkingCost = (e: Request) => {
  let usd = thinkingCosts.get(e);
  if (usd === undefined) {
    const t = counts(e), model = e.effectiveModel ?? e.model;
    const full = tokenCost(e.provider, model, e.at, t);
    const visible = tokenCost(e.provider, model, e.at, { ...t, outputTokens: e.outputTokens - (e.thinkingTokens ?? 0) });
    usd = full && visible ? full.usd - visible.usd : 0;
    thinkingCosts.set(e, usd);
  }
  return usd;
};
export const kind = (t: Turn): TurnKind => {
  const requests = t.requests.filter((e) => e.sessionKind !== 'compaction');
  return requests.length > CHANGE_MAX_REQUESTS || requests.some((e) => e.sessionKind === 'subagent') ? 'long' : requests.length <= QUESTION_MAX_REQUESTS ? 'question' : 'change';
};

/** A turn's scoped requests with the figures every estimate reuses, worked out once per report. */
interface Measured extends Turn {
  /** Requests at the turn's own setting; subagents can run another. */
  own: Request[];
  kind: TurnKind; costUsd: number; thinkingTokens: number; thinkingCostUsd: number; ownThinkingCostUsd: number;
  steps: number; thinkingSteps: number | null;
  /** Every request reported its thinking tokens. */
  measured: boolean;
  /** Measured, and every request's model has a list price. */
  estimable: boolean;
}
function measure(turn: Turn): Measured {
  const own = turn.requests.filter((e) => sameSetting(e, turn.first));
  const { steps, thinkingSteps } = measureTurnSteps(turn.requests);
  const measured = turn.requests.every((e) => e.thinkingTokens != null);
  return {
    ...turn, own, kind: kind(turn), costUsd: sum(turn.requests, cost), thinkingTokens: sum(turn.requests, (e) => e.thinkingTokens ?? 0),
    thinkingCostUsd: sum(turn.requests, thinkingCost), ownThinkingCostUsd: sum(own, thinkingCost),
    steps, thinkingSteps,
    measured, estimable: measured && turn.requests.every((e) => currentRates(e.effectiveModel ?? e.model)),
  };
}
const bucket = (t: Measured) => t.thinkingTokens <= LIGHT_THINKING_MAX ? 'light' : t.thinkingTokens <= TYPICAL_THINKING_MAX ? 'typical' : 'heavy';

/** Retained turns use their first root request's setting; scoped requests contribute their stored cost. */
export function thinkingActivity(db: Db, raw: Partial<ThinkingQuery> | undefined, models: OfferedModel[], retained: Pick<RetainedTurns, 'get'> = { get: loadRetainedTurns }): ThinkingReport | null {
  if (typeof raw?.from !== 'number' || typeof raw.to !== 'number' || !Number.isFinite(raw.from) || !Number.isFinite(raw.to) || raw.from > raw.to) return null;
  const q = { from: raw.from, to: raw.to, scope: normalizeScope(raw.scope) };
  const { turns: all, excluded } = retained.get(db, q.from, q.to);
  const inTime = (e: Request) => Date.parse(e.at) >= q.from && Date.parse(e.at) <= q.to;
  const untracked = { requests: 0, costUsd: 0 };
  const omit = (e: Request) => { untracked.requests++; untracked.costUsd += cost(e); };
  for (const e of excluded) if (inTime(e) && inScope(q.scope, e)) omit(e);
  const turns: Measured[] = [];
  for (const t of all) {
    if (!inTime(t.first)) continue;
    const tracked = EFFORTS.includes(t.first.reasoningEffort ?? '') ? scopedTurnRequests(t, q.scope) : [];
    if (tracked.length) turns.push(measure({ first: t.first, requests: tracked }));
    else for (const e of t.requests) if (inScope(q.scope, e)) omit(e);
  }
  const days = [...new Set(turns.map((t) => localDay(Date.parse(t.first.at))))].sort();
  const factor = days.length ? DAYS_PER_WEEK / days.length : 0;
  const groups = new Map<string, Measured[]>();
  for (const t of turns) { const key = settingKey(setting(t.first)), own = groups.get(key) ?? []; own.push(t); groups.set(key, own); }
  const settings = [...groups.values()].map((own) => {
    const s = setting(own[0]!.first), total = sum(own, (t) => t.costUsd), tc = sum(own, (t) => t.thinkingCostUsd);
    const observed = new Set(turns.filter((t) => t.first.provider === s.provider).map((t) => t.first.reasoningEffort));
    const lower = EFFORTS.slice(EFFORTS.indexOf(s.effort) + 1).filter((effort) => observed.has(effort) || effort === UNIVERSAL_COMPARISON_EFFORT);
    const ratios = new Map<string, number | null>();
    const ratio = (effort: string, k?: TurnKind): number | null => {
      const key = JSON.stringify([effort, k ?? null]);
      if (ratios.has(key)) return ratios.get(key)!;
      const a = own.filter((t) => t.measured && (!k || t.kind === k));
      const b = (groups.get(settingKey({ ...s, effort })) ?? []).filter((t) => t.measured && (!k || t.kind === k));
      const denominator = median(a.map((t) => t.thinkingTokens));
      const value = a.length < MIN_RATIO_TURNS || b.length < MIN_RATIO_TURNS ? k ? ratio(effort) : null
        : denominator > 0 ? Math.min(median(b.map((t) => t.thinkingTokens)) / denominator, 1) : null;
      ratios.set(key, value);
      return value;
    };
    const estimate = (t: Measured, effort: string) => {
      if (!t.estimable) return null;
      const r = ratio(effort, t.kind);
      return r === null ? null : t.costUsd - t.ownThinkingCostUsd * (1 - r);
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
      let estimate = t.costUsd;
      for (const e of t.own) {
        const priced = tokenCost(e.provider, m.id, e.at, counts(e));
        if (!priced) return null;
        estimate += priced.usd - cost(e);
      }
      return estimate;
    }), 'unpriced'));
    const mixedEffort = lower.find((effort) => ratio(effort, 'question') !== null && ratio(effort, 'change') !== null && own.every((t) => t.kind === 'long' || estimate(t, effort) !== null));
    if (mixedEffort) alternatives.push(alternative({ ...s, effort: mixedEffort }, 'mixed', own.map((t) => t.kind === 'long' ? t.costUsd : estimate(t, mixedEffort))));
    const knownThinkingSteps = own.flatMap((t) => (t.thinkingSteps === null ? [] : [t.thinkingSteps]));
    return {
      setting: s, turns: own.length, measuredTurns: own.filter((t) => t.measured).length,
      costUsd: total, costUsdPerWeek: total * factor, thinkingCostUsd: tc, thinkingShare: total ? tc / total : 0, medianTurnCostUsd: median(own.map((t) => t.costUsd)),
      meanStepsPerTurn: mean(own.map((t) => t.steps)), medianStepsPerTurn: median(own.map((t) => t.steps)),
      meanThinkingStepsPerTurn: knownThinkingSteps.length ? mean(knownThinkingSteps) : null,
      medianThinkingStepsPerTurn: knownThinkingSteps.length ? median(knownThinkingSteps) : null,
      buckets: THINKING_BUCKETS.map((b) => { const selected = own.filter((t) => bucket(t) === b), thinkingCostUsd = sum(selected, (t) => t.thinkingCostUsd); return { bucket: b, turns: selected.length, turnShare: selected.length / own.length, thinkingCostUsd, thinkingCostShare: tc ? thinkingCostUsd / tc : 0 }; }),
      kinds: TURN_KINDS.map((k) => {
        const selected = own.filter((t) => t.kind === k), costUsd = sum(selected, (t) => t.costUsd);
        const effort = lower.find((e) => selected.length > 0 && selected.every((t) => estimate(t, e) !== null));
        const kindThinking = selected.flatMap((t) => (t.thinkingSteps === null ? [] : [t.thinkingSteps]));
        return { kind: k, turns: selected.length, costUsd, costShare: total ? costUsd / total : 0, thinkingShare: costUsd ? sum(selected, (t) => t.thinkingCostUsd) / costUsd : 0,
          meanStepsPerTurn: mean(selected.map((t) => t.steps)),
          meanThinkingStepsPerTurn: kindThinking.length ? mean(kindThinking) : null,
          lowerEffortSavingUsdPerWeek: effort ? sum(selected, (t) => t.costUsd - estimate(t, effort)!) * factor : null };
      }), alternatives,
    };
  }).sort((a, b) => b.costUsd - a.costUsd);
  return { coveredFrom: days[0] ?? null, coveredTo: days.at(-1) ?? null, coveredDays: days.length, settings, untracked };
}
