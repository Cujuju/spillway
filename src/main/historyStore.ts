import { existsSync, readFileSync } from 'node:fs';
import type { HistorySample, UsageSnapshot } from '@shared/types';
import { appPaths } from './paths';
import { writeFileAtomic } from './settingsStore';

/** One point per 5 min is finer than any weekly-chart pixel and keeps 14 days near 4k points. */
const SAMPLE_SPACING_MS = 5 * 60_000;
/** Longest forecast lookback plus the chart's past range. */
const RETENTION_MS = 14 * 24 * 60 * 60_000;
const SAVE_DEBOUNCE_MS = 5_000;

export function toSample(snapshot: UsageSnapshot): HistorySample {
  const used: HistorySample['used'] = {};
  for (const c of snapshot.credentials) {
    for (const w of c.windows) {
      if (w.usedPercent === null) continue;
      (used[c.id] ??= {})[w.key] = w.usedPercent;
    }
  }
  return { at: snapshot.fetchedAt, used };
}

/** True when any window dropped, i.e. a reset happened; that point must be kept to show the jump. */
function hasReset(prev: HistorySample, next: HistorySample): boolean {
  for (const [id, windows] of Object.entries(next.used)) {
    for (const [key, value] of Object.entries(windows)) {
      const before = prev.used[id]?.[key];
      if (before !== undefined && value < before) return true;
    }
  }
  return false;
}

/** Appends `next` unless it is too close to the last kept point; returns the trimmed list. */
export function appendSample(samples: HistorySample[], next: HistorySample, now = Date.parse(next.at)): HistorySample[] {
  const last = samples.at(-1);
  const keep = !last || now - Date.parse(last.at) >= SAMPLE_SPACING_MS || hasReset(last, next);
  const out = keep ? [...samples, next] : samples;
  const cutoff = now - RETENTION_MS;
  const firstKept = out.findIndex((s) => Date.parse(s.at) >= cutoff);
  return firstKept <= 0 ? out : out.slice(firstKept);
}

class HistoryStore {
  private samples: HistorySample[] | null = null;
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

  add(snapshot: UsageSnapshot): void {
    const before = this.all();
    const after = appendSample(before, toSample(snapshot));
    if (after === before) return;
    this.samples = after;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.samples) writeFileAtomic(appPaths.historyFile, JSON.stringify(this.samples));
  }

  clear(): void {
    this.samples = [];
    this.flush();
  }
}

export const history = new HistoryStore();
