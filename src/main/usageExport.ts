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
let exportStatus: 'uninitialized' | 'loading' | 'enabled' | 'disabled' | 'retry' = 'uninitialized';
let refreshGeneration = 0;

function mirrorUsage(allSamples: boolean, enabled: boolean): Promise<void> {
  const oldestAt = iso(Date.now() - HISTORY_RETENTION_MS);
  if (!enabled) return activityLog.call('clickhouseMirrorUsage', [], oldestAt);
  const samples = history.all();
  const records = [...(allSamples ? samples : samples.slice(-1)).map(sample), ...history.summaries().map(window), ...history.observed().map(span)];
  return activityLog.call('clickhouseMirrorUsage', records, oldestAt);
}

/** Mirrors usage history into the worker for ClickHouse: every sample, or only the newest after a poll. */
export function exportUsage(allSamples: boolean): void {
  if (!allSamples) {
    if (exportStatus === 'enabled') void mirrorUsage(false, true).catch(console.error);
    else if (exportStatus === 'retry') exportUsage(true);
    return;
  }
  const generation = ++refreshGeneration;
  exportStatus = 'loading';
  void activityLog.call('clickhouseStatus').then(({ config }) => {
    if (generation !== refreshGeneration) return;
    const enabled = config.enabled && config.stores.usage;
    exportStatus = enabled ? 'enabled' : 'disabled';
    return mirrorUsage(true, enabled);
  }).catch((error: unknown) => {
    if (generation === refreshGeneration) exportStatus = 'retry';
    console.error(error);
  });
}
