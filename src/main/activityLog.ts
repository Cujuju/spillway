import { addEvent, emptyCounts } from '@shared/activityCounts';
import {
  ACTIVITY_PAGE_SIZE, type ActivityBucket, type ActivityCount, type ActivityDayTotal, type ActivityEvent, type ActivityPage, type ActivityPageQuery, type StoredActivityEvent,
} from '@shared/types';
import { DAY_KEY, importLegacyFiles, openActivityDb, totalKey, type Db } from './activityDb';
import { appPaths } from './paths';
import { getSecrets, getSettings } from './settingsStore';

const pad = (n: number) => String(n).padStart(2, '0');
/** Local calendar day, YYYY-MM-DD, so days match the user's clock. */
export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Oldest local day inside the newest `retentionDays` days ending today. */
export function oldestKeptDay(today: number, retentionDays: number): string {
  const d = new Date(today);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (retentionDays - 1)).getTime());
}

/** Local days, YYYY-MM-DD, from `count - 1` days before `today` through today. */
export function lastDays(today: number, count: number): string[] {
  const d = new Date(today);
  return Array.from({ length: count }, (_, i) => localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (count - 1 - i)).getTime()));
}

/** Adds one request to its day/account/model row and returns that row. */
export function addToTotals(totals: Map<string, ActivityDayTotal>, e: ActivityEvent): ActivityDayTotal {
  const base = { day: localDay(Date.parse(e.at)), provider: e.provider, authIndex: e.authIndex, model: e.model };
  const key = totalKey(base);
  const row = totals.get(key) ?? { ...base, ...emptyCounts() };
  addEvent(row, e);
  totals.set(key, row);
  return row;
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

interface RequestRow {
  id: number;
  event: string;
}
const toStored = (r: RequestRow): StoredActivityEvent => ({ ...(JSON.parse(r.event) as ActivityEvent), id: r.id });

/** Renderer input arrives untyped over IPC. */
function normalizeQuery(q: Partial<ActivityPageQuery> | undefined): ActivityPageQuery | null {
  const day = q?.day ?? null;
  const before = q?.before ?? null;
  if (day !== null && (typeof day !== 'string' || !DAY_KEY.test(day))) return null;
  if (before !== null && !Number.isSafeInteger(before)) return null;
  return { day, failedOnly: q?.failedOnly === true, before };
}

/**
 * Every request in the encrypted database (activityDb.ts), kept for the "Keep requests for" setting,
 * plus per-day totals that are kept until cleared.
 */
class ActivityLog {
  private conn: Db | null = null;
  /** Mirror of `day_totals`; null until first read. */
  private totals: Map<string, ActivityDayTotal> | null = null;
  private prunedOn = '';
  /** Hourly sums of finished days; their rows no longer change. */
  private pastBuckets = new Map<string, ActivityBucket[]>();

  /** Opens on first use, after secrets load. */
  private get db(): Db {
    if (!this.conn) {
      this.conn = openActivityDb(appPaths.activityDb, getSecrets().databaseKey);
      importLegacyFiles(this.conn, appPaths.legacyActivityDir);
    }
    return this.conn;
  }

  append(e: ActivityEvent): StoredActivityEvent {
    const day = localDay(Date.parse(e.at));
    const totals = this.loadTotals();
    let id: number;
    try {
      id = this.db.transaction(() => {
        const row = addToTotals(totals, e);
        this.db.prepare('INSERT OR REPLACE INTO day_totals (key, total) VALUES (?, ?)').run(totalKey(row), JSON.stringify(row));
        return Number(this.db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)').run(day, e.failed ? 1 : 0, JSON.stringify(e)).lastInsertRowid);
      })();
    } catch (err) {
      // The mirror already counted it; reload from the rolled-back table.
      this.totals = null;
      throw err;
    }
    if (this.prunedOn !== localDay(Date.now())) this.prune();
    return { ...e, id };
  }

  page(query: ActivityPageQuery): ActivityPage {
    const q = normalizeQuery(query);
    if (!q) return { events: [], more: false };
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.day !== null) {
      where.push('day = ?');
      params.push(q.day);
    }
    if (q.failedOnly) where.push('failed = 1');
    if (q.before !== null) {
      where.push('id < ?');
      params.push(q.before);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // One extra row says whether another page follows.
    const rows = this.db.prepare(`SELECT id, event FROM requests ${filter} ORDER BY id DESC LIMIT ?`).all(...params, ACTIVITY_PAGE_SIZE + 1) as RequestRow[];
    return { events: rows.slice(0, ACTIVITY_PAGE_SIZE).map(toStored), more: rows.length > ACTIVITY_PAGE_SIZE };
  }

  count(day: string | null): ActivityCount {
    if (day !== null && (typeof day !== 'string' || !DAY_KEY.test(day))) return { requests: 0, failed: 0, newestId: 0 };
    const sql = `SELECT count(*) AS requests, coalesce(sum(failed), 0) AS failed, coalesce(max(id), 0) AS newestId FROM requests${day === null ? '' : ' WHERE day = ?'}`;
    return this.db.prepare(sql).get(...(day === null ? [] : [day])) as ActivityCount;
  }

  /** Days with stored requests, newest first. */
  days(): string[] {
    return (this.db.prepare('SELECT DISTINCT day FROM requests ORDER BY day DESC').all() as { day: string }[]).map((r) => r.day);
  }

  /** One day's requests, oldest first. */
  day(day: string): StoredActivityEvent[] {
    if (!DAY_KEY.test(day)) return [];
    return (this.db.prepare('SELECT id, event FROM requests WHERE day = ? ORDER BY id').all(day) as RequestRow[]).map(toStored);
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

  /** Deletes requests outside the retention setting; their totals stay. */
  prune(): void {
    this.prunedOn = localDay(Date.now());
    const oldest = oldestKeptDay(Date.now(), getSettings().activity.retentionDays);
    this.db.prepare('DELETE FROM requests WHERE day < ?').run(oldest);
    for (const day of this.pastBuckets.keys()) if (day < oldest) this.pastBuckets.delete(day);
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM requests; DELETE FROM day_totals;');
    })();
    this.totals = new Map();
    this.pastBuckets.clear();
  }

  /** Drops the caches too: the next open may find another file (set aside, or imported). */
  close(): void {
    this.conn?.close();
    this.conn = null;
    this.totals = null;
    this.pastBuckets.clear();
  }

  private loadTotals(): Map<string, ActivityDayTotal> {
    if (this.totals) return this.totals;
    const rows = this.db.prepare('SELECT total FROM day_totals').all() as { total: string }[];
    this.totals = new Map(rows.map((r) => {
      const t = JSON.parse(r.total) as ActivityDayTotal;
      return [totalKey(t), t];
    }));
    return this.totals;
  }
}

export const activityLog = new ActivityLog();
