import type { ActivityScope } from './activityScope';
import type { ActivityBucket, ActivityDaySummary, StoredActivityEvent } from './types';
/** A read from the optional ClickHouse long-term store. `error` is status-only text, safe to show. */
export type OlderRead<T> = { state: 'off' } | { state: 'unavailable'; error: string } | ({ state: 'ok' } & T);
export interface OlderBuckets { buckets: ActivityBucket[]; /** Row cap reached: some rows are missing. */ truncated: boolean }
export interface OlderDaysQuery { scope: ActivityScope; /** Local day YYYY-MM-DD; the window ends just before it. null: the first local day retention no longer keeps. */ before: string | null }
export interface OlderDays { days: ActivityDaySummary[]; /** First local day of the window read. */ from: string; /** Requests exist before `from`. */ earlier: boolean }
export interface OlderPageQuery { day: string; failedOnly: boolean; scope: ActivityScope; offset: number; /** Whole day (capped), for orders the renderer sorts. */ whole: boolean }
export interface OlderPage { events: StoredActivityEvent[]; more: boolean; /** Row cap reached: the day has more rows than were read. */ truncated: boolean }
/** Local days each "older days" read covers. */
export const OLDER_DAYS_WINDOW = 30;
