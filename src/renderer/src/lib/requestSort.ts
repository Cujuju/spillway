import { tokenCost } from '@shared/modelPrices';
import type { StoredActivityEvent } from '@shared/types';

export type SortKey = 'time' | 'account' | 'conversation' | 'result' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost' | 'firstToken' | 'totalTime';
export interface RequestSort {
  key: SortKey;
  desc: boolean;
}
/** Display text for values the rows hold as IDs. */
export interface RowLabels {
  account: (authIndex: string | null) => string;
  conversation: (sessionId: string | null) => string;
}

export interface RequestColumn {
  key: SortKey;
  label: string;
  /** Numbers align right. */
  num: boolean;
  title?: string;
  /** Null (no price, no first token) sorts last in either direction. */
  value: (e: StoredActivityEvent, labels: RowLabels) => number | string | null;
}

export const REQUEST_COLUMNS: readonly RequestColumn[] = [
  // Recorded order, the same order the database pages in.
  { key: 'time', label: 'Time', num: false, value: (e) => e.id },
  { key: 'account', label: 'Account · model', num: false, value: (e, l) => `${l.account(e.authIndex)} ${e.model}`.toLowerCase() },
  { key: 'conversation', label: 'Conversation', num: false, title: 'The client conversation; "moved" marks a switch to another account', value: (e, l) => l.conversation(e.sessionId).toLowerCase() || null },
  { key: 'result', label: 'Result', num: false, value: (e) => (e.failed ? (e.statusCode ?? null) : 0) },
  { key: 'input', label: 'Input', num: true, value: (e) => e.inputTokens },
  { key: 'output', label: 'Output', num: true, value: (e) => e.outputTokens },
  { key: 'cacheRead', label: 'Cache read', num: true, value: (e) => e.cachedTokens },
  { key: 'cacheWrite', label: 'Cache write', num: true, value: (e) => e.cacheWriteTokens },
  { key: 'cost', label: 'API cost', num: true, title: 'At API list prices', value: (e) => tokenCost(e.provider, e.model, e)?.usd ?? null },
  { key: 'firstToken', label: 'First token', num: true, title: 'Time to first token', value: (e) => e.ttftMs },
  { key: 'totalTime', label: 'Total time', num: true, value: (e) => e.latencyMs },
];

export const DEFAULT_SORT: RequestSort = { key: 'time', desc: true };

/** Newest first is the database's own order, so only it pages from the database; every other order sorts a loaded day. */
export const isRecordedOrder = (s: RequestSort) => s.key === DEFAULT_SORT.key && s.desc === DEFAULT_SORT.desc;

export const isRequestSort = (v: unknown): v is RequestSort =>
  !!v && typeof v === 'object' && REQUEST_COLUMNS.some((c) => c.key === (v as RequestSort).key) && typeof (v as RequestSort).desc === 'boolean';

/** Clicks on a column step through ascending, descending, then back to the default. Newest first is the default, so Time just flips. */
export function nextSort(current: RequestSort, key: SortKey): RequestSort {
  if (current.key !== key || isRecordedOrder(current)) return { key, desc: false };
  return current.desc ? DEFAULT_SORT : { key, desc: true };
}

/** Sorted copy; rows without a value go last, and ties keep newest first. */
export function sortRequests(rows: readonly StoredActivityEvent[], sort: RequestSort, labels: RowLabels): StoredActivityEvent[] {
  const col = REQUEST_COLUMNS.find((c) => c.key === sort.key)!;
  const dir = sort.desc ? -1 : 1;
  const compare = (a: number | string | null, b: number | string | null) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -dir : dir;
  };
  return rows
    .map((e) => ({ e, v: col.value(e, labels) }))
    .sort((a, b) => compare(a.v, b.v) || b.e.id - a.e.id)
    .map((r) => r.e);
}
