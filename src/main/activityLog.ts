import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { addEvent, emptyCounts, withCountsFilled } from '@shared/activityCounts';
import type { ActivityBucket, ActivityDayTotal, ActivityEvent } from '@shared/types';
import { appPaths } from './paths';
import { getSettings, writeFileAtomic } from './settingsStore';

/** Batches a burst of requests into one append. */
const APPEND_DELAY_MS = 1_000;
/** Totals change on every request; quit flushes the latest. */
const TOTALS_SAVE_DELAY_MS = 30_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const TOTALS_FILE = 'daily-totals.json';

const pad = (n: number) => String(n).padStart(2, '0');
/** Local calendar day, YYYY-MM-DD, so days match the user's clock. */
export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Days strictly older than the newest `retentionDays` days ending today. */
export function expiredDays(days: string[], today: number, retentionDays: number): string[] {
  const d = new Date(today);
  const oldestKept = localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (retentionDays - 1)).getTime());
  return days.filter((day) => day < oldestKept);
}

/** Local days, YYYY-MM-DD, from `count - 1` days before `today` through today. */
export function lastDays(today: number, count: number): string[] {
  const d = new Date(today);
  return Array.from({ length: count }, (_, i) => localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (count - 1 - i)).getTime()));
}

/** Requests saved before cache writes were recorded have none. */
const withCacheWrites = <T extends { cacheWriteTokens?: number }>(r: T): T & { cacheWriteTokens: number } => ({ ...r, cacheWriteTokens: r.cacheWriteTokens ?? 0 });

const totalKey = (t: Pick<ActivityDayTotal, 'day' | 'provider' | 'authIndex' | 'model'>) => `${t.day}|${t.provider}|${t.authIndex ?? ''}|${t.model}`;

/** Adds one request to its day/account/model row. */
export function addToTotals(totals: Map<string, ActivityDayTotal>, e: ActivityEvent): void {
  const base = { day: localDay(Date.parse(e.at)), provider: e.provider, authIndex: e.authIndex, model: e.model };
  const key = totalKey(base);
  const row = totals.get(key) ?? { ...base, ...emptyCounts() };
  addEvent(row, e);
  totals.set(key, row);
}

/** One day's requests summed per local hour, account and model. */
export function hourlyBuckets(events: ActivityEvent[]): ActivityBucket[] {
  const rows = new Map<string, ActivityBucket>();
  for (const e of events) {
    const at = new Date(Date.parse(e.at));
    at.setMinutes(0, 0, 0);
    const base = { start: at.getTime(), wholeDay: false, provider: e.provider, authIndex: e.authIndex, model: e.model };
    const key = `${base.start}|${base.provider}|${base.authIndex ?? ''}|${base.model}`;
    const row = rows.get(key) ?? { ...base, ...emptyCounts() };
    addEvent(row, e);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/**
 * Every request on disk: one JSON line per request in a file per local day, kept for the
 * "Keep requests for" setting, plus per-day totals that are kept until cleared.
 */
class ActivityLog {
  private pending = new Map<string, string[]>();
  private appendTimer: NodeJS.Timeout | null = null;
  private totals: Map<string, ActivityDayTotal> | null = null;
  private totalsTimer: NodeJS.Timeout | null = null;
  private prunedOn = '';
  /** Hourly sums of finished days; their files no longer change. */
  private pastBuckets = new Map<string, ActivityBucket[]>();

  append(e: ActivityEvent): void {
    const day = localDay(Date.parse(e.at));
    const lines = this.pending.get(day) ?? [];
    lines.push(JSON.stringify(e));
    this.pending.set(day, lines);
    addToTotals(this.loadTotals(), e);
    this.appendTimer ??= setTimeout(() => this.flushRequests(), APPEND_DELAY_MS);
    this.totalsTimer ??= setTimeout(() => this.flushTotals(), TOTALS_SAVE_DELAY_MS);
    if (this.prunedOn !== localDay(Date.now())) this.prune();
  }

  /** Days with stored requests, newest first. */
  days(): string[] {
    this.flushRequests();
    if (!existsSync(appPaths.activityDir)) return [];
    return readdirSync(appPaths.activityDir).flatMap((f) => DAY_FILE.exec(f)?.[1] ?? []).sort().reverse();
  }

  /** One day's requests, oldest first. */
  day(day: string): ActivityEvent[] {
    this.flushRequests();
    const file = path.join(appPaths.activityDir, `${day}.jsonl`);
    if (!DAY_FILE.test(`${day}.jsonl`) || !existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      if (!line) return [];
      try {
        const e = JSON.parse(line) as ActivityEvent;
        return typeof e?.at === 'string' && typeof e.requestId === 'string' ? [withCacheWrites(e)] : [];
      } catch {
        return [];
      }
    });
  }

  totalsList(): ActivityDayTotal[] {
    return [...this.loadTotals().values()];
  }

  /** Hourly activity for the last `days` local days; days whose requests expired come from their totals. */
  buckets(days: number): ActivityBucket[] {
    const today = localDay(Date.now());
    const stored = new Set(this.days());
    return lastDays(Date.now(), days).flatMap((day) => {
      if (stored.has(day)) {
        const cached = this.pastBuckets.get(day);
        if (cached) return cached;
        const rows = hourlyBuckets(this.day(day));
        if (day < today) this.pastBuckets.set(day, rows);
        return rows;
      }
      const [y, m, d] = day.split('-').map(Number);
      const start = new Date(y!, m! - 1, d!).getTime();
      return this.totalsList().filter((t) => t.day === day).map(({ day: _, ...t }): ActivityBucket => ({ ...t, start, wholeDay: true }));
    });
  }

  /** Deletes day files outside the retention setting. */
  prune(): void {
    this.prunedOn = localDay(Date.now());
    for (const day of expiredDays(this.days(), Date.now(), getSettings().activity.retentionDays)) {
      rmSync(path.join(appPaths.activityDir, `${day}.jsonl`), { force: true });
    }
  }

  flush(): void {
    this.flushRequests();
    this.flushTotals();
  }

  clear(): void {
    if (this.appendTimer) clearTimeout(this.appendTimer);
    if (this.totalsTimer) clearTimeout(this.totalsTimer);
    this.appendTimer = this.totalsTimer = null;
    this.pending.clear();
    this.totals = new Map();
    this.pastBuckets.clear();
    rmSync(appPaths.activityDir, { recursive: true, force: true });
  }

  private flushRequests(): void {
    if (this.appendTimer) clearTimeout(this.appendTimer);
    this.appendTimer = null;
    if (!this.pending.size) return;
    mkdirSync(appPaths.activityDir, { recursive: true });
    for (const [day, lines] of this.pending) appendFileSync(path.join(appPaths.activityDir, `${day}.jsonl`), `${lines.join('\n')}\n`);
    this.pending.clear();
  }

  private flushTotals(): void {
    if (this.totalsTimer) clearTimeout(this.totalsTimer);
    this.totalsTimer = null;
    if (this.totals) writeFileAtomic(path.join(appPaths.activityDir, TOTALS_FILE), JSON.stringify([...this.totals.values()]));
  }

  private loadTotals(): Map<string, ActivityDayTotal> {
    if (this.totals) return this.totals;
    const file = path.join(appPaths.activityDir, TOTALS_FILE);
    try {
      const raw: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
      const rows = Array.isArray(raw) ? raw.filter((r): r is ActivityDayTotal => typeof r?.day === 'string' && typeof r?.requests === 'number') : [];
      this.totals = new Map(rows.map((r) => [totalKey(r), withCountsFilled(r)]));
    } catch (err) {
      console.error('[activity] totals unreadable, starting empty:', err);
      this.totals = new Map();
    }
    return this.totals;
  }
}

export const activityLog = new ActivityLog();
