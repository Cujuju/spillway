/** Activity → Thinking: is everyday work paying for thinking it doesn't need, and would a cheaper setting do? */
import type { ActivityScope } from './activityScope';

/** Thinking tokens per turn. Fixed so "heavy" means the same for every setting and user. */
export const LIGHT_THINKING_MAX = 2_000;
export const TYPICAL_THINKING_MAX = 20_000;
/** Requests per turn, subagents included. A turn with a subagent is always long. */
export const QUESTION_MAX_REQUESTS = 2;
export const CHANGE_MAX_REQUESTS = 15;
/** Fewer own turns than this at an effort, per kind, and the effort ratio is not estimated. */
export const MIN_RATIO_TURNS = 10;

export type TurnKind = 'question' | 'change' | 'long';
export type ThinkingBucket = 'light' | 'typical' | 'heavy';
export const TURN_KINDS: readonly TurnKind[] = ['question', 'change', 'long'];
export const THINKING_BUCKETS: readonly ThinkingBucket[] = ['light', 'typical', 'heavy'];

export interface ThinkingQuery {
  scope: ActivityScope;
  /** Epoch ms; turns starting inside [from, to] count. */
  from: number;
  to: number;
}

/** Effective model and reasoning effort; provider decides pricing and replay route. */
export interface ThinkingSetting { provider: string; model: string; effort: string }
export const settingKey = (s: ThinkingSetting): string => JSON.stringify([s.provider, s.model, s.effort]);

export interface BucketStat {
  bucket: ThinkingBucket;
  turns: number;
  /** 0..1 of this setting's turns. */
  turnShare: number;
  thinkingCostUsd: number;
  /** 0..1 of this setting's thinking cost. */
  thinkingCostShare: number;
}

export interface KindStat {
  kind: TurnKind;
  turns: number;
  costUsd: number;
  /** 0..1 of this setting's cost. */
  costShare: number;
  /** 0..1 of this kind's cost that was thinking. */
  thinkingShare: number;
  /** At the next lower effort with an estimate; null when not enough data. */
  lowerEffortSavingUsdPerWeek: number | null;
}

export type EstimateMethod = 'effort-ratio' | 'reprice' | 'mixed';
export type NoEstimateReason = 'not-enough-data' | 'unpriced';

export interface Alternative {
  setting: ThinkingSetting;
  /** 'mixed': the lower effort for questions and changes, this setting for long tasks. */
  method: EstimateMethod;
  /** Null with `reason` when there is no estimate. */
  costUsdPerWeek: number | null;
  savingUsdPerWeek: number | null;
  /** 0..1 of this setting's weekly cost. */
  savingShare: number | null;
  medianTurnCostUsd: number | null;
  reason: NoEstimateReason | null;
}

export interface SettingReport {
  setting: ThinkingSetting;
  turns: number;
  costUsd: number;
  costUsdPerWeek: number;
  thinkingCostUsd: number;
  /** 0..1 of cost that was thinking. */
  thinkingShare: number;
  medianTurnCostUsd: number;
  buckets: BucketStat[];
  kinds: KindStat[];
  /** Lower efforts on this model first, then cheaper models at this effort, then the mixed option. */
  alternatives: Alternative[];
}

export interface ThinkingReport {
  /** Days that have turn data inside the query, as local YYYY-MM-DD; null when none. */
  coveredFrom: string | null;
  coveredTo: string | null;
  coveredDays: number;
  /** Costliest first. */
  settings: SettingReport[];
  /** Requests left out: no recorded effort or no turn key. */
  untracked: { requests: number; costUsd: number };
}
