import type { HistorySample, ObservedSpan, WindowSummary } from '@shared/types';
import { sameReset, windowEnd } from '@shared/usageWindows';

/** Keep one year of windows so past weeks survive raw-history trimming without unbounded storage. */
const SUMMARY_RETENTION_MS = 365 * 24 * 60 * 60_000;
const FULL = 100;

/** The window a pair's newest reading went to; summaries are in time order, so the last one for the pair. */
const currentIndex = (summaries: WindowSummary[], credentialId: string, key: string) =>
  summaries.findLastIndex((s) => s.credentialId === credentialId && s.key === key);

/** Folds each reading into the window whose reset it reports. Unused windows are provisional (idle Codex reports a reset a window ahead): a new reset replaces them. */
export function foldSample(summaries: WindowSummary[], sample: HistorySample): WindowSummary[] {
  const out = [...summaries];
  const at = Date.parse(sample.at);
  for (const [credentialId, windows] of Object.entries(sample.used)) {
    for (const [key, used] of Object.entries(windows)) {
      const resetAt = sample.resets?.[credentialId]?.[key];
      // An idle on_use window reports no reset: there is no window to record.
      if (resetAt === undefined) continue;
      const index = currentIndex(out, credentialId, key);
      const current = out[index];
      const opened: WindowSummary = { credentialId, key, firstSampleAt: at, lastSampleAt: at, resetAt, endedAt: null, peak: used, exhaustedAt: used >= FULL ? at : null };
      if (current && sameReset(current.resetAt, resetAt)) {
        out[index] = { ...current, lastSampleAt: at, peak: Math.max(current.peak, used), exhaustedAt: current.exhaustedAt ?? opened.exhaustedAt };
      } else if (current && current.peak === 0) {
        out[index] = opened;
      } else {
        // A new window before the old reset (e.g. a reset credit) ends the old one here.
        if (current && current.resetAt > at && !sameReset(current.resetAt, at)) out[index] = { ...current, endedAt: at };
        out.push(opened);
      }
    }
  }
  return out;
}

/** Drops windows past retention, and finished ones that never saw use (provisional readings, not windows). */
export function pruneSummaries(summaries: WindowSummary[], now: number): WindowSummary[] {
  return summaries.filter((s) => s.resetAt >= now - SUMMARY_RETENTION_MS && (s.peak > 0 || windowEnd(s) > now));
}

/** Extends each read window's latest span, or opens one after a gap over `maxGapMs`. Unused windows leave no summary, so spans tell no use from no reading. */
export function foldObserved(spans: ObservedSpan[], sample: HistorySample, maxGapMs: number): ObservedSpan[] {
  const out = [...spans];
  const at = Date.parse(sample.at);
  for (const [credentialId, windows] of Object.entries(sample.used)) {
    for (const key of Object.keys(windows)) {
      const index = out.findLastIndex((s) => s.credentialId === credentialId && s.key === key);
      const last = out[index];
      if (last && at - last.to <= maxGapMs) out[index] = { ...last, to: Math.max(last.to, at) };
      else out.push({ credentialId, key, from: at, to: at });
    }
  }
  return out;
}

export const pruneObserved = (spans: ObservedSpan[], now: number): ObservedSpan[] => spans.filter((s) => s.to >= now - SUMMARY_RETENTION_MS);
