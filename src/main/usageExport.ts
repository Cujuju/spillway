import type { HistorySample, ObservedSpan, WindowSummary } from '@shared/types';
import { activityLog } from './activityService';
import type { MirrorRecord } from './clickhouseRecords';
import { HISTORY_RETENTION_MS } from './historyMerge';
import { history } from './historyStore';

const iso = (ms: number) => new Date(ms).toISOString();
// Keys stay stable while a record changes: a window by its first reset reading, a span by its start.
const sample = (s: HistorySample): MirrorRecord => ({ kind: 'usage-sample', key: s.at, at: s.at, record: JSON.stringify(s) });
const window = (w: WindowSummary): MirrorRecord => ({ kind: 'usage-window', key: `${w.credentialId}|${w.key}|${w.resetAt}`, at: iso(w.firstSampleAt), record: JSON.stringify(w) });
const span = (o: ObservedSpan): MirrorRecord => ({ kind: 'usage-span', key: `${o.credentialId}|${o.key}|${o.from}`, at: iso(o.from), record: JSON.stringify(o) });

/** Mirrors usage history into the worker for ClickHouse: every sample, or only the newest after a poll. */
export function exportUsage(allSamples: boolean): void {
  const samples = history.all();
  const records = [...(allSamples ? samples : samples.slice(-1)).map(sample), ...history.summaries().map(window), ...history.observed().map(span)];
  void activityLog.call('clickhouseMirrorUsage', records, iso(Date.now() - HISTORY_RETENTION_MS)).catch(console.error);
}
