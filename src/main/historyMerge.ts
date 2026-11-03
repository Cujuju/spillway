import type { HistorySample, ObservedSpan, WindowSummary } from '@shared/types';
import { sameReset } from '@shared/usageWindows';
import { pruneObserved, pruneSummaries } from './windowSummaries';

/** Sample retention: longest forecast lookback plus the chart's past range. */
export const HISTORY_RETENTION_MS = 14 * 24 * 60 * 60_000;
export interface TransferHistory { samples: HistorySample[]; summaries: WindowSummary[]; observed: ObservedSpan[] }
const earliest = (a: number | null, b: number | null): number | null => a === null ? b : b === null ? a : Math.min(a, b);
const pairKey = (s: { credentialId: string; key: string }) => JSON.stringify([s.credentialId, s.key]);

export function mergeHistory(a: TransferHistory, b: TransferHistory, now = Date.now()): TransferHistory {
  const byTime = new Map<string, HistorySample>();
  for (const s of [...a.samples, ...b.samples]) {
    const prev = byTime.get(s.at);
    const mergeReadings = (left: HistorySample['used'], right: HistorySample['used']) => {
      const out: HistorySample['used'] = {};
      for (const readings of [left, right]) for (const [id, windows] of Object.entries(readings)) {
        for (const [key, value] of Object.entries(windows)) (out[id] ??= {})[key] = Math.max(out[id]?.[key] ?? -Infinity, value);
      }
      return out;
    };
    byTime.set(s.at, { at: s.at, used: mergeReadings(prev?.used ?? {}, s.used),
      ...((prev?.resets || s.resets) ? { resets: mergeReadings(prev?.resets ?? {}, s.resets ?? {}) } : {}) });
  }
  const samples = [...byTime.values()].filter((s) => Date.parse(s.at) >= now - HISTORY_RETENTION_MS)
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const summaries: WindowSummary[] = [];
  const windows = [...a.summaries, ...b.summaries].sort((x, y) => pairKey(x).localeCompare(pairKey(y)) || x.resetAt - y.resetAt);
  for (const s of windows) {
    const prev = summaries.at(-1);
    // Keep the group's first reset as its anchor, so a chain of jitter cannot join distinct windows.
    if (prev && pairKey(prev) === pairKey(s) && sameReset(prev.resetAt, s.resetAt)) {
      summaries[summaries.length - 1] = { ...prev, firstSampleAt: Math.min(prev.firstSampleAt, s.firstSampleAt),
        lastSampleAt: Math.max(prev.lastSampleAt, s.lastSampleAt), peak: Math.max(prev.peak, s.peak),
        endedAt: earliest(prev.endedAt, s.endedAt), exhaustedAt: earliest(prev.exhaustedAt, s.exhaustedAt) };
    } else summaries.push({ ...s });
  }
  const observed: ObservedSpan[] = [];
  const spans = [...a.observed, ...b.observed].sort((x, y) => pairKey(x).localeCompare(pairKey(y)) || x.from - y.from);
  for (const s of spans) {
    const prev = observed.at(-1);
    if (prev && pairKey(prev) === pairKey(s) && s.from <= prev.to) prev.to = Math.max(prev.to, s.to);
    else observed.push({ ...s });
  }
  return { samples, summaries: pruneSummaries(summaries, now).sort((x, y) => x.firstSampleAt - y.firstSampleAt),
    observed: pruneObserved(observed, now) };
}
