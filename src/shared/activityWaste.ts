/** Activity → Waste tab contract (#253): prompt bloat, cost anatomy, cold cache misses, and top burn sessions. */
import type { DaySpan } from './activityCompare';
import type { ActivityScope } from './activityScope';

export interface WasteQuery {
  scope: ActivityScope;
  /** Epoch ms, or null for all retained requests; retained requests inside [from, to] count. */
  from: number | null;
  to: number;
}

export type PromptBucketId = 'under100k' | '100kTo200k' | '200kTo350k' | 'over350k';

export interface PromptBucketStat {
  id: PromptBucketId;
  label: string;
  requests: number;
  costUsd: number;
  /** Fraction of total priced spend (0–1). */
  share: number;
}

/** Exact components of total list-price API cost (sum equals `totalCostUsd`). */
export interface CostAnatomy {
  uncachedInputUsd: number;
  cacheWriteUsd: number;
  cacheReadUsd: number;
  outputUsd: number;
}

export interface ColdMissGroup {
  requests: number;
  costUsd: number;
}

export interface ColdMissSummary {
  total: ColdMissGroup;
  /** Cold cache misses after a >5 minute idle gap in the same session. */
  afterIdle: ColdMissGroup;
  /** Cold cache misses within <=5 minutes of the previous request in the same session. */
  midTurn: ColdMissGroup;
  /** Qualifying cold misses without a session ID or retained preceding request. */
  unclassified: ColdMissGroup;
  /** Effort changes between consecutive requests of the same model inside a session. */
  effortSwitches: number;
  /** Model changes between consecutive requests inside a session. */
  modelSwitches: number;
}

export type WasteDriverTag =
  | 'over350k'
  | 'over200k'
  | 'idleWakes'
  | 'midTurnMisses'
  | 'effortSwitch'
  | 'modelSwitch'
  | 'lowCache';

export interface TopWasteSession {
  sessionId: string;
  provider: string;
  model: string;
  effort: string | null;
  requests: number;
  costUsd: number;
  maxPromptTokens: number;
  avgPromptTokens: number;
  /** Share of prompt tokens read from cache (0–1). */
  cacheHitRate: number;
  coldMissUsd: number;
  idleWakes: number;
  midTurnMisses: number;
  effortSwitches: number;
  modelSwitches: number;
  drivers: WasteDriverTag[];
  firstAt: string;
  lastAt: string;
}

export interface WasteReport {
  range: DaySpan;
  retained: DaySpan | null;
  requests: number;
  pricedRequests: number;
  unpricedRequests: number;
  failedRequests: number;
  totalCostUsd: number;
  avgPromptTokens: number;
  p90PromptTokens: number;
  over200kCostUsd: number;
  /** Share of total spend on requests with prompts > 200K tokens (0–1). */
  over200kShare: number;
  anatomy: CostAnatomy;
  promptBuckets: PromptBucketStat[];
  coldMisses: ColdMissSummary;
  topSessions: TopWasteSession[];
}
