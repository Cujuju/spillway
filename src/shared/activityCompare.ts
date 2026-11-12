/** Activity → Overview's combination cards and Compare table (#156): whole range from hourly totals, per task from retained requests. */
import type { ActivityScope } from './activityScope';
import type { ActivityCounts } from './types';

/** Columns the Compare table fits beside its labels. */
export const MAX_COMBOS = 4;
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

export interface CompareRow extends Combo {
  key: string;
  /** Whole range, from hourly totals. */
  whole: ActivityCounts & { promptTokens: number };
  /** Retained requests; null when no task started here. */
  tasks: TaskStats | null;
  /** This combination's cost inside tasks that started on another one. */
  asSubagentCostUsd: number;
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
