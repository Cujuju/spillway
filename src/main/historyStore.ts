import { existsSync, readFileSync } from 'node:fs';
import type { HistorySample, ObservedSpan, UsageSnapshot, WindowSummary } from '@shared/types';
import { HISTORY_SAMPLE_SPACING_MS, missedReadingGapMs, resetBetween } from '@shared/usageWindows';
import { appPaths } from './paths';
import { getSettings, writeFileAtomic } from './settingsStore';
import { HISTORY_RETENTION_MS } from './historyMerge';
import { foldObserved, foldSample, pruneObserved, pruneSummaries } from './windowSummaries';

const MS_PER_SECOND = 1000;

/** The newest point changes every poll; saving at the spacing bounds writes, and quit flushes it. */
const SAVE_DELAY_MS = HISTORY_SAMPLE_SPACING_MS;

/** Expects a snapshot rolled past its resets, so a window that reset reads zero. */
export function toSample(snapshot: UsageSnapshot): HistorySample {
  const used: HistorySample['used'] = {};
  const resets: NonNullable<HistorySample['resets']> = {};
  for (const c of snapshot.credentials) {
    for (const w of c.windows) {
      if (w.usedPercent === null) continue;
      (used[c.id] ??= {})[w.key] = w.usedPercent;
      if (w.resetsAt) (resets[c.id] ??= {})[w.key] = Date.parse(w.resetsAt);
    }
  }
  return { at: snapshot.fetchedAt, used, resets };
}

/** True when any window dropped or passed its reset; both sides of it must be kept. */
function hasReset(prev: HistorySample, next: HistorySample): boolean {
  for (const [id, windows] of Object.entries(next.used)) {
    for (const [key, value] of Object.entries(windows)) {
      const before = prev.used[id]?.[key];
      if (before !== undefined && (value < before || resetBetween(prev, next, id, key))) return true;
    }
  }
  return false;
}

/**
 * Appends `next` and trims past retention. The newest point always lands; it replaces the previous
 * newest when that one is within spacing of its predecessor and no reset lies between.
 */
export function appendSample(samples: HistorySample[], next: HistorySample, now = Date.parse(next.at)): HistorySample[] {
  const last = samples.at(-1);
  const anchor = samples.at(-2);
  const provisional = last && anchor && Date.parse(last.at) - Date.parse(anchor.at) < HISTORY_SAMPLE_SPACING_MS;
  const out = provisional && !hasReset(last, next) ? [...samples.slice(0, -1), next] : [...samples, next];
  const cutoff = now - HISTORY_RETENTION_MS;
  const firstKept = out.findIndex((s) => Date.parse(s.at) >= cutoff);
  return firstKept <= 0 ? out : out.slice(firstKept);
}

const isWindowSummary = (s: Partial<WindowSummary> | null): s is WindowSummary =>
  typeof s?.credentialId === 'string' && typeof s.key === 'string' && typeof s.resetAt === 'number' && typeof s.peak === 'number' && s.endedAt !== undefined;
const isObservedSpan = (s: Partial<ObservedSpan> | null): s is ObservedSpan =>
  typeof s?.credentialId === 'string' && typeof s.key === 'string' && typeof s.from === 'number' && typeof s.to === 'number';

/** Reads a stored list; with no file yet, rebuilds it from the samples still held. */
function loadList<T>(file: string, isItem: (x: Partial<T> | null) => x is T, rebuild: () => T[]): T[] {
  try {
    if (!existsSync(file)) return rebuild();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw.filter(isItem) : [];
  } catch (err) {
    console.error(`[history] unreadable ${file}, starting empty:`, err);
    return [];
  }
}

const maxReadingGapMs = () => missedReadingGapMs(getSettings().dashboard.refreshIntervalSeconds * MS_PER_SECOND);

class HistoryStore {
  private samples: HistorySample[] | null = null;
  private windowSummaries: WindowSummary[] | null = null;
  private observedSpans: ObservedSpan[] | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  all(): HistorySample[] {
    if (this.samples) return this.samples;
    try {
      const raw = existsSync(appPaths.historyFile) ? JSON.parse(readFileSync(appPaths.historyFile, 'utf8')) : [];
      this.samples = Array.isArray(raw) ? raw.filter((s): s is HistorySample => typeof s?.at === 'string' && typeof s?.used === 'object') : [];
    } catch (err) {
      console.error('[history] unreadable, starting empty:', err);
      this.samples = [];
    }
    return this.samples;
  }

  summaries(): WindowSummary[] {
    this.windowSummaries ??= loadList(appPaths.windowSummariesFile, isWindowSummary, () => this.all().reduce(foldSample, [] as WindowSummary[]));
    return this.windowSummaries;
  }

  observed(): ObservedSpan[] {
    this.observedSpans ??= loadList(appPaths.observedSpansFile, isObservedSpan, () => {
      const maxGapMs = maxReadingGapMs();
      return this.all().reduce((spans: ObservedSpan[], s) => foldObserved(spans, s, maxGapMs), []);
    });
    return this.observedSpans;
  }

  add(snapshot: UsageSnapshot): void {
    const before = this.all();
    const next = toSample(snapshot);
    const now = Date.parse(snapshot.fetchedAt);
    this.windowSummaries = pruneSummaries(foldSample(this.summaries(), next), now);
    this.observedSpans = pruneObserved(foldObserved(this.observed(), next, maxReadingGapMs()), now);
    this.samples = appendSample(before, next);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.samples) writeFileAtomic(appPaths.historyFile, JSON.stringify(this.samples));
    if (this.windowSummaries) writeFileAtomic(appPaths.windowSummariesFile, JSON.stringify(this.windowSummaries));
    if (this.observedSpans) writeFileAtomic(appPaths.observedSpansFile, JSON.stringify(this.observedSpans));
  }

  clear(): void {
    this.samples = [];
    this.windowSummaries = [];
    this.observedSpans = [];
    this.flush();
  }
}

export const history = new HistoryStore();
