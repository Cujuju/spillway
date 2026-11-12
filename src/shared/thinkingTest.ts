/** Activity → Thinking's quality test: replays sampled turns' captured requests at cheaper settings and grades whether the next move matches. */
import type { ThinkingQuery, ThinkingSetting, TurnKind } from './thinking';

/** Turns a test samples, as offered in its plan. */
export const TEST_TURN_CHOICES = [10, 20, 40] as const;
export const DEFAULT_TEST_TURNS = 20;
/** Fewer graded turns than this in a kind reads "too few to tell". */
export const MIN_KIND_GRADED = 5;

export interface TestPlanRequest {
  query: ThinkingQuery;
  setting: ThinkingSetting;
  /** Settings to replay at; each sampled turn is replayed at every one. */
  alternatives: ThinkingSetting[];
  turns: number;
}

/** What a test would do and cost; nothing runs until it is started. Expires like an eval replay preview. */
export interface TestPlan {
  id: string;
  setting: ThinkingSetting;
  alternatives: ThinkingSetting[];
  /** Turns sampled per kind, spread evenly across the kinds that have replayable turns. */
  sampled: { kind: TurnKind; turns: number }[];
  /** This setting's turns in range, and how many have a complete captured request to replay. */
  eligibleTurns: number;
  replayableTurns: number;
  /** Why the other turns can't be replayed, most common first. */
  skipped: { reason: string; turns: number }[];
  /** Replays plus grading, at list prices with a cold prompt cache. */
  estimatedCostUsd: number;
  expiresAt: string;
}

export type TestState = 'running' | 'complete' | 'failed' | 'canceled';
export type TurnOutcome = 'match' | 'differ' | 'error';

export interface TurnGrade {
  /** The sampled turn's first request time and trace, for finding it in Traces. */
  turnAt: string;
  traceId: string | null;
  kind: TurnKind;
  alternative: ThinkingSetting;
  outcome: TurnOutcome;
  /** The grader's one-sentence reason, or the error. */
  reason: string;
}

export interface KindResult { kind: TurnKind; matched: number; graded: number }

export interface AlternativeResult {
  setting: ThinkingSetting;
  matched: number;
  /** Turns graded match or differ; errors are not graded. */
  graded: number;
  errors: number;
  byKind: KindResult[];
  /** 0..1 match rate with each kind weighted by its share of this setting's turns; null when nothing was graded. */
  weightedMatchShare: number | null;
}

export interface ThinkingTest {
  id: string;
  setting: ThinkingSetting;
  state: TestState;
  startedAt: string;
  finishedAt: string | null;
  /** Replays finished and planned, across every alternative. */
  done: number;
  total: number;
  /** Spent so far on replays and grading. */
  costUsd: number;
  results: AlternativeResult[];
  grades: TurnGrade[];
  error: string | null;
}
