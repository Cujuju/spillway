/** Activity → Overview's combination cards and Compare table (#156): whole range from hourly totals, per task from retained requests. */
import type { ActivityScope } from './activityScope';
import type { PlanReach } from './quotaValue';
import type { ActivityCounts } from './types';

/** Combinations shown until the user picks: the costliest in the range. */
export const DEFAULT_COMBOS = 3;

export interface CompareQuery {
  scope: ActivityScope;
  /** Epoch ms; hours starting inside [from, to] count, as on the rest of the Overview. */
  from: number;
  to: number;
}

/** Effective model (requested model when unknown) and reasoning effort. */
export interface Combo { model: string; effort: string }
export const comboKey = (c: Combo): string => JSON.stringify([c.model, c.effort]);
export function parseComboKey(key: string): Combo | null {
  try {
    const v: unknown = JSON.parse(key);
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? { model: v[0], effort: v[1] } : null;
  } catch {
    return null;
  }
}

/** Tasks (root sessions, subagents counted toward them) that started on one combination. */
export interface TaskStats {
  tasks: number;
  /** Per task: cost of every combination's requests inside it. */
  medianCostUsd: number;
  meanCostUsd: number;
  p90CostUsd: number;
  /** Prompt plus output tokens. */
  medianTokens: number;
  medianRequests: number;
  /** All of these tasks' cost. */
  costUsd: number;
  /** Tasks with a request on another combination. */
  mixed: number;
  /** Other combinations' cost inside these tasks. */
  otherCostUsd: number;
}

/** Per-user-turn step counts (subagents included) for turns that started on one combination. */
export interface TurnStats {
  turns: number;
  meanSteps: number;
  medianSteps: number;
  /** Null when no turn reported thinking tokens or thinking presence on every step. */
  meanThinkingSteps: number | null;
  medianThinkingSteps: number | null;
}

export interface CompareRow extends Combo {
  key: string;
  /** Dominant provider serving this combination in range; null when absent. */
  provider: string | null;
  /** Whole range, from hourly totals. */
  whole: ActivityCounts & { promptTokens: number };
  /** Retained requests; null when no task started here. */
  tasks: TaskStats | null;
  /** Retained turns; null when no user turn started here. */
  turns: TurnStats | null;
  /** This combination's cost inside tasks that started on another one. */
  asSubagentCostUsd: number;
  /** Implied per-account quota bucket values for this model's provider; null without enough clean intervals. */
  planReach: PlanReach | null;
}

/** Local days, YYYY-MM-DD, through the range's end. */
export interface DaySpan { from: string; to: string; days: number }

export interface CompareReport {
  /** Every combination in the range, costliest first. */
  combos: CompareRow[];
  range: DaySpan;
  /** The part of the range with retained requests; null when none. */
  retained: DaySpan | null;
  /** The part of the range whose totals keep the thinking, tier and failed-cost shares (#155); null when none. */
  shares: DaySpan | null;
  /** Requests with no recorded effort, left out of every combination. */
  unknownEffort: { requests: number; costUsd: number; unpricedRequests: number; models: { model: string; requests: number; costUsd: number; unpricedRequests: number }[] };
}

/** Linear interpolation between closest ranks; `sorted` ascending and non-empty. */
export function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const MEDIAN = 0.5;
const P90 = 0.9;
const median = (values: number[]) => quantile(values.toSorted((a, b) => a - b), MEDIAN);

/** One task's sums; `byCombo` is each combination's cost inside it. */
export interface TaskSums { combo: string; costUsd: number; tokens: number; requests: number; byCombo: Map<string, number> }

/** Stats for the tasks that started on `combo`; null when none did. */
export function taskStats(combo: string, tasks: TaskSums[]): TaskStats | null {
  if (!tasks.length) return null;
  const costs = tasks.map((t) => t.costUsd).sort((a, b) => a - b);
  const costUsd = costs.reduce((a, b) => a + b, 0);
  const other = (t: TaskSums) => [...t.byCombo].filter(([k]) => k !== combo);
  return {
    tasks: tasks.length, medianCostUsd: quantile(costs, MEDIAN), meanCostUsd: costUsd / tasks.length, p90CostUsd: quantile(costs, P90),
    medianTokens: median(tasks.map((t) => t.tokens)), medianRequests: median(tasks.map((t) => t.requests)), costUsd,
    mixed: tasks.filter((t) => other(t).length > 0).length,
    otherCostUsd: tasks.reduce((sum, t) => sum + other(t).reduce((s, [, c]) => s + c, 0), 0),
  };
}

/** Per-turn step and thinking-step stats; null when no turns exist. */
export function turnStats(turns: readonly { steps: number; thinkingSteps: number | null }[]): TurnStats | null {
  if (!turns.length) return null;
  const steps = turns.map((t) => t.steps);
  const meanSteps = steps.reduce((a, b) => a + b, 0) / steps.length;
  const thinking = turns.flatMap((t) => (t.thinkingSteps === null ? [] : [t.thinkingSteps]));
  return {
    turns: turns.length,
    meanSteps,
    medianSteps: median(steps),
    meanThinkingSteps: thinking.length ? thinking.reduce((a, b) => a + b, 0) / thinking.length : null,
    medianThinkingSteps: thinking.length ? median(thinking) : null,
  };
}
