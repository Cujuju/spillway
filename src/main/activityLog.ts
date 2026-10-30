import { addEvent, emptyCounts, localDay } from '@shared/activityCounts';
import { EVERY_REQUEST, inScope, normalizeScope, type ActivityScope } from '@shared/activityScope';
import {
  ACTIVITY_PAGE_SIZE, type ActivityBucket, type ActivityDaySummary, type ActivityDayTotal, type ActivityEvent, type ActivityPage, type ActivityPageQuery, type StoredActivityEvent,
} from '@shared/types';
import { ACCOUNT_KEY_SQL, CLIENT_KEY_SQL, CONVERSATION_KEY_SQL, DAY_KEY, importLegacyFiles, openActivityDb, type Db } from './activityDb';
import { addToTotals, dailyTotals, readTotals, storedTotalKey, toBucket, type ActivityTotal } from './activityTotals';
import { identityKey, reconcileUsage, rememberUsage } from './usageLedger';
import { appPaths } from './paths';
import { getSecrets, getSettings } from './settingsStore';

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

interface RequestRow {
  id: number;
  event: string;
}
function toStored(r: RequestRow): StoredActivityEvent {
  // Requests stored before conversations or clients were recorded lack these fields.
  const e = JSON.parse(r.event) as Omit<ActivityEvent, 'sessionId' | 'movedFrom' | 'userAgent' | 'client'> & Partial<ActivityEvent>;
  return { ...e, source: e.source ?? 'proxy', upstreamId: e.upstreamId ?? null, cacheWriteTokens: e.cacheWriteTokens ?? 0, sessionId: e.sessionId ?? null, movedFrom: e.movedFrom ?? null, userAgent: e.userAgent ?? null, client: e.client ?? null, id: r.id };
}
const conversationKey = (e: ActivityEvent) => `${e.sessionId}|${e.model}`;

/** Renderer input arrives untyped over IPC. */
function normalizeQuery(q: Partial<ActivityPageQuery> | undefined): ActivityPageQuery | null {
  const day = q?.day ?? null;
  const before = q?.before ?? null;
  if (day !== null && (typeof day !== 'string' || !DAY_KEY.test(day))) return null;
  if (before !== null && !Number.isSafeInteger(before)) return null;
  return { day, failedOnly: q?.failedOnly === true, scope: normalizeScope(q?.scope), before };
}

/** SQL condition limiting requests to `scope`'s accounts and clients; null when every request is in scope. */
function scopeClause(scope: ActivityScope): { sql: string; params: string[] } | null {
  const parts: string[] = scope.source === 'proxy' ? ["coalesce(json_extract(event, '$.source'), 'proxy') = 'proxy'"] : [];
  const params: string[] = [];
  for (const [keySql, keys] of [[ACCOUNT_KEY_SQL, scope.accounts], [CLIENT_KEY_SQL, scope.clients]] as const) {
    if (keys === null) continue;
    parts.push(`${keySql} IN (${keys.map(() => '?').join(', ')})`);
    params.push(...keys);
  }
  return parts.length ? { sql: parts.join(' AND '), params } : null;
}

/**
 * Every request in the encrypted database (activityDb.ts), kept for the "Keep requests for" setting,
 * plus hourly totals that are kept until cleared.
 */
class ActivityLog {
  revision = 0;
  private conn: Db | null = null;
  /** Mirror of `activity_totals`; null until first read. */
  private totals: Map<string, ActivityTotal> | null = null;
  private prunedOn = '';
  /** Latest account per conversation and model (conversationKey), filled from the database on first sight. */
  private conversationAccounts = new Map<string, string | null>();

  /** Opens on first use, after secrets load. */
  private get db(): Db {
    if (!this.conn) {
      this.conn = openActivityDb(appPaths.activityDb, getSecrets().databaseKey);
      importLegacyFiles(this.conn, appPaths.legacyActivityDir);
      if (!this.conn.prepare("SELECT 1 FROM meta WHERE key = 'usage-ledger-seeded'").get()) {
        this.conn.transaction(() => {
          for (const r of this.conn!.prepare('SELECT id, event FROM requests').all() as RequestRow[]) {
            const e = toStored(r);
            rememberUsage(this.conn!, e, r.id, null);
          }
          this.conn!.prepare("INSERT INTO meta VALUES ('usage-ledger-seeded', '1')").run();
        })();
      }
    }
    return this.conn;
  }

  checkpoint(file: string): string | undefined {
    return (this.db.prepare('SELECT state FROM client_log_checkpoints WHERE path = ?').get(file) as { state: string } | undefined)?.state;
  }

  importBatch(file: string, state: string, events: ActivityEvent[]): void {
    try {
      this.db.transaction(() => {
        for (const e of events) this.append(e);
        this.db.prepare('INSERT OR REPLACE INTO client_log_checkpoints VALUES (?, ?)').run(file, state);
      })();
    } catch (e) {
      this.totals = null;
      this.conversationAccounts.clear();
      this.prunedOn = '';
      throw e;
    }
  }

  append(event: ActivityEvent): StoredActivityEvent {
    const e = { ...event, source: event.source ?? 'proxy', upstreamId: event.upstreamId ?? null, movedFrom: this.movedFrom(event) };
    const day = localDay(Date.parse(e.at));
    const totals = this.loadTotals();
    let id: number;
    try {
      id = this.db.transaction(() => {
        const merge = reconcileUsage(this.db, e);
        if (merge.remove) {
          this.revision += 1;
          const old = merge.remove;
          const key = merge.removeKey!;
          const total = totals.get(key);
          if (total) {
            const counts = emptyCounts();
            addEvent(counts, old);
            for (const k of Object.keys(counts) as (keyof typeof counts)[]) total[k] -= counts[k];
            this.db.prepare('INSERT OR REPLACE INTO activity_totals VALUES (?, ?)').run(key, JSON.stringify(total));
          }
        }
        if (merge.skip) return merge.id ?? 0;
        const row = addToTotals(totals, e);
        this.db.prepare('INSERT OR REPLACE INTO activity_totals (key, total) VALUES (?, ?)').run(storedTotalKey(row), JSON.stringify(row));
        const id = Number(this.db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)').run(day, e.failed ? 1 : 0, JSON.stringify(e)).lastInsertRowid);
        rememberUsage(this.db, e, id);
        this.db.prepare('UPDATE usage_identities SET row_id = ? WHERE key = ?').run(id, identityKey(e));
        return id;
      })();
    } catch (err) {
      // The mirror already counted it; reload from the rolled-back table.
      this.totals = null;
      throw err;
    }
    if (this.prunedOn !== localDay(Date.now())) this.prune();
    if (e.sessionId) this.conversationAccounts.set(conversationKey(e), e.authIndex);
    return { ...e, id };
  }

  /** The conversation's previous account on this model, when this attempt went to another one. */
  private movedFrom(e: ActivityEvent): string | null {
    if (!e.sessionId || !e.authIndex) return null;
    const key = conversationKey(e);
    if (!this.conversationAccounts.has(key)) {
      const row = this.db.prepare(`SELECT event FROM requests WHERE (${CONVERSATION_KEY_SQL}) = (?, ?) ORDER BY id DESC LIMIT 1`).get(e.sessionId, e.model) as RequestRow | undefined;
      this.conversationAccounts.set(key, row ? toStored(row).authIndex : null);
    }
    const previous = this.conversationAccounts.get(key) ?? null;
    return previous && previous !== e.authIndex ? previous : null;
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
    const scope = scopeClause(q.scope);
    if (scope) {
      where.push(scope.sql);
      params.push(...scope.params);
    }
    if (q.before !== null) {
      where.push('id < ?');
      params.push(q.before);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // One extra row says whether another page follows.
    const rows = this.db.prepare(`SELECT id, event FROM requests ${filter} ORDER BY id DESC LIMIT ?`).all(...params, ACTIVITY_PAGE_SIZE + 1) as RequestRow[];
    return { events: rows.slice(0, ACTIVITY_PAGE_SIZE).map(toStored), more: rows.length > ACTIVITY_PAGE_SIZE };
  }

  /** Each day with stored requests in `scope`, newest first; cost comes from the day's totals. */
  daySummaries(rawScope: ActivityScope = EVERY_REQUEST): ActivityDaySummary[] {
    const scope = normalizeScope(rawScope);
    const clause = scopeClause(scope);
    const sql = `SELECT day, count(*) AS requests, sum(failed) AS failed, max(id) AS newestId FROM requests ${clause ? `WHERE ${clause.sql}` : ''} GROUP BY day ORDER BY day DESC`;
    const rows = this.db.prepare(sql).all(...(clause?.params ?? [])) as Pick<ActivityDaySummary, 'day' | 'requests' | 'failed' | 'newestId'>[];
    const cost = new Map<string, Pick<ActivityDaySummary, 'costUsd' | 'unpricedRequests'>>();
    for (const t of this.totalsList()) {
      if (!inScope(scope, t)) continue;
      const c = cost.get(t.day) ?? { costUsd: 0, unpricedRequests: 0 };
      c.costUsd += t.costUsd;
      c.unpricedRequests += t.unpricedRequests;
      cost.set(t.day, c);
    }
    return rows.map((r) => ({ ...r, ...(cost.get(r.day) ?? { costUsd: 0, unpricedRequests: 0 }) }));
  }

  /** Days with stored requests, newest first. */
  days(): string[] {
    return (this.db.prepare('SELECT DISTINCT day FROM requests ORDER BY day DESC').all() as { day: string }[]).map((r) => r.day);
  }

  /** All of one day's requests in `scope`, newest first. */
  day(day: string, failedOnly = false, scope: ActivityScope = EVERY_REQUEST): StoredActivityEvent[] {
    if (typeof day !== 'string' || !DAY_KEY.test(day)) return [];
    const clause = scopeClause(normalizeScope(scope));
    const sql = `SELECT id, event FROM requests WHERE day = ?${failedOnly === true ? ' AND failed = 1' : ''}${clause ? ` AND ${clause.sql}` : ''} ORDER BY id DESC`;
    return (this.db.prepare(sql).all(day, ...(clause?.params ?? [])) as RequestRow[]).map(toStored);
  }

  totalsList(): ActivityDayTotal[] {
    return dailyTotals(this.loadTotals().values());
  }

  /** Hourly activity for the last `days` local days; days whose requests expired come from their totals. */
  buckets(days: number): ActivityBucket[] {
    const wanted = new Set(lastDays(Date.now(), days));
    return [...this.loadTotals().values()].filter((t) => wanted.has(t.day)).map(toBucket);
  }

  /** Deletes requests outside the retention setting; their totals stay. */
  prune(): void {
    this.prunedOn = localDay(Date.now());
    const oldest = oldestKeptDay(Date.now(), getSettings().activity.retentionDays);
    this.db.prepare('DELETE FROM requests WHERE day < ?').run(oldest);
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM requests; DELETE FROM activity_totals; DELETE FROM usage_identities;');
    })();
    this.totals = new Map();
    this.conversationAccounts.clear();
  }

  /** Drops the caches too: the next open may find another file (set aside, or imported). */
  close(): void {
    this.conn?.close();
    this.conn = null;
    this.totals = null;
    this.conversationAccounts.clear();
  }

  private loadTotals(): Map<string, ActivityTotal> {
    if (this.totals) return this.totals;
    this.totals = readTotals(this.db);
    return this.totals;
  }
}

export const activityLog = new ActivityLog();
