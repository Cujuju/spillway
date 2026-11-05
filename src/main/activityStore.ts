import { backfillLegacyUsage, matchLegacyUsage } from './legacyUsage';
import { exportActivityEvents, oldestKeptDay, lastDays, preserveImportedCost } from './activityTransfer';
export { oldestKeptDay, lastDays } from './activityTransfer';
import { clientLogKey } from './clientLogPaths';
import { connectionStatements } from './connectionStatements';
import { localDay } from '@shared/activityCounts';
import { normalizeTransport } from '@shared/activityTransport';
import { EVERY_REQUEST, inScope, normalizeScope, type ActivityScope } from '@shared/activityScope';
import {
  ACTIVITY_PAGE_SIZE, RHYTHM_LOOKBACK_DAYS, type ActivityBucket, type ActivityBucketSnapshot, type ActivityDaySummary, type ActivityDayTotal, type ActivityEvent, type ActivityPage, type ActivityPageQuery, type ProxyCoverage, type StoredActivityEvent,
} from '@shared/types';
import { ACCOUNT_KEY_SQL, CLIENT_KEY_SQL, CONVERSATION_KEY_SQL, DAY_KEY, importLegacyFiles, openActivityDb, type Db } from './activityDb';
import { addToTotals, dailyTotals, readTotals, storedTotalKey, toBucket, type ActivityTotal } from './activityTotals';
import { accountedUsage, identityKey, reconcileUsage, rememberUsage, type AccountedActivityEvent } from './usageLedger';

interface RequestRow {
  id: number;
  event: string;
}
function toStored(r: RequestRow): StoredActivityEvent {
  // Requests stored before conversations or clients were recorded lack these fields.
  const e = JSON.parse(r.event) as Omit<ActivityEvent, 'sessionId' | 'movedFrom' | 'userAgent' | 'client'> & Partial<ActivityEvent>;
  return { ...e, ...normalizeTransport(e), effectiveModel: e.effectiveModel ?? null, reasoningEffort: e.reasoningEffort ?? null, parentSessionId: e.parentSessionId ?? null,
    latencyMs: e.source === 'client-log' ? null : e.latencyMs ?? null, ttftMs: e.source === 'client-log' ? null : e.ttftMs ?? null,
    source: e.source ?? 'proxy', upstreamId: e.upstreamId ?? null, cacheWriteTokens: e.cacheWriteTokens ?? 0, sessionId: e.sessionId ?? null, movedFrom: e.movedFrom ?? null, userAgent: e.userAgent ?? null, client: e.client ?? null, id: r.id };
}
const conversationKey = (e: ActivityEvent) => `${e.sessionId}|${e.model}`;
const statementsFor = connectionStatements({
  checkpoint: 'SELECT state FROM client_log_checkpoints WHERE path = ?',
  changes: 'SELECT total_changes() AS n',
  prune: 'DELETE FROM requests WHERE day < ?',
  saveCheckpoint: 'INSERT OR REPLACE INTO client_log_checkpoints VALUES (?, ?)',
  storedRequest: 'SELECT id, event FROM requests WHERE id = (SELECT row_id FROM usage_identities WHERE key = ?)',
  identity: 'SELECT 1 FROM usage_identities WHERE key = ?',
  saveTotal: 'INSERT OR REPLACE INTO activity_totals (key, total) VALUES (?, ?)',
  insertRequest: 'INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)',
  linkIdentity: 'UPDATE usage_identities SET row_id = ? WHERE key = ?',
  identityRow: 'SELECT row_id FROM usage_identities WHERE key = ?',
  conversation: `SELECT event FROM requests WHERE (${CONVERSATION_KEY_SQL}) = (?, ?) ORDER BY id DESC LIMIT 1`,
});

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
  for (const [keySql, keys] of [[ACCOUNT_KEY_SQL, scope.accounts], [CLIENT_KEY_SQL, scope.clients], ["coalesce(json_extract(event, '$.reasoningEffort'), '')", scope.efforts ?? null]] as const) {
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
export interface ActivityConfig { activityDb: string; legacyActivityDir: string; databaseKey: string; retentionDays: number }
export class ActivityLog {
  constructor(private config: ActivityConfig) {}
  setRetention(days: number): void { this.config.retentionDays = days; this.prune(); }
  revision = 0;
  private conn: Db | null = null;
  /** Mirror of `activity_totals`; null until first read. */
  private totals: Map<string, ActivityTotal> | null = null;
  private prunedOn = '';
  private importing = false;
  /** This worker is the sole checkpoint writer; retain reads until the connection closes. */
  private checkpoints = new Map<string, string | undefined>();
  /** Latest account per conversation and model (conversationKey), filled from the database on first sight. */
  private conversationAccounts = new Map<string, string | null>();

  /** Opens on first use, after secrets load. */
  private get db(): Db {
    if (!this.conn) {
      this.conn = openActivityDb(this.config.activityDb, this.config.databaseKey);
      importLegacyFiles(this.conn, this.config.legacyActivityDir);
      if (!this.conn.prepare("SELECT 1 FROM meta WHERE key = 'usage-ledger-seeded'").get()) {
        this.conn.transaction(() => {
          for (const r of this.conn!.prepare('SELECT id, day, event FROM requests').all() as (RequestRow & { day: string })[]) {
            const e = toStored(r);
            // Old totals did not count timings; seeding identities must not manufacture subtraction samples.
            rememberUsage(this.conn!, { ...e, latencyCount: 0, latencySumMs: 0, ttftCount: 0, ttftSumMs: 0 }, r.id, null, r.day);
          }
          this.conn!.prepare("INSERT INTO meta VALUES ('usage-ledger-seeded', '1')").run();
        })();
      }
      backfillLegacyUsage(this.conn);
    }
    return this.conn;
  }
  private get statements() { return statementsFor(this.db); }

  checkpoint(file: string): string | undefined {
    file = clientLogKey(file);
    if (!this.checkpoints.has(file)) this.checkpoints.set(file,
      (this.statements.checkpoint.get(file) as { state: string } | undefined)?.state);
    return this.checkpoints.get(file);
  }

  importBatch(file: string, state: string, events: ActivityEvent[]): boolean {
    return this.importEvents(events, { file: clientLogKey(file), state });
  }
  importEvents(events: AccountedActivityEvent[], checkpoint?: { file: string; state: string }): boolean {
    try {
      const changed = this.db.transaction(() => {
        const changes = () => (this.statements.changes.get() as { n: number }).n;
        const before = events.length ? changes() : 0;
        this.importing = true;
        try { for (const e of events) this.append(e); }
        finally { this.importing = false; }
        if (matchLegacyUsage(this.db, events.map(identityKey))) { this.totals = null; this.revision += 1; }
        this.statements.prune.run(oldestKeptDay(Date.now(), this.config.retentionDays));
        const changed = events.length > 0 && changes() !== before;
        if (checkpoint) this.statements.saveCheckpoint.run(checkpoint.file, checkpoint.state);
        return changed;
      })();
      if (checkpoint) this.checkpoints.set(checkpoint.file, checkpoint.state);
      this.db.pragma('incremental_vacuum');
      return changed;
    } catch (e) {
      this.totals = null;
      this.conversationAccounts.clear();
      this.prunedOn = '';
      throw e;
    }
  }
  exportEvents(): Generator<AccountedActivityEvent> { return exportActivityEvents(this.db); }

  append(event: AccountedActivityEvent): StoredActivityEvent | null {
    // A committed append can lose its reply in a worker crash; preserve its original movedFrom on replay.
    if (event.source !== 'client-log') {
      const existing = this.statements.storedRequest.get(identityKey(event)) as RequestRow | undefined;
      if (existing) {
        const stored = toStored(existing);
        if (stored.source === (event.source ?? 'proxy') && stored.requestId === event.requestId && stored.authIndex === event.authIndex && stored.at === event.at) return stored;
      }
      // Accounted events outlive their retained request rows; acknowledge without resurrecting details.
      if (this.statements.identity.get(identityKey(event))) return null;
    }
    const { costUsd, uncachedCostUsd, ...details } = event;
    const e = { ...details, ...normalizeTransport(event), effectiveModel: event.effectiveModel ?? null, reasoningEffort: event.reasoningEffort ?? null,
      parentSessionId: event.parentSessionId ?? null, latencyMs: event.source === 'client-log' ? null : event.latencyMs ?? null,
      ttftMs: event.source === 'client-log' ? null : event.ttftMs ?? null,
      source: event.source ?? 'proxy', upstreamId: event.upstreamId ?? null, movedFrom: this.movedFrom(event) };
    const accounted = { ...e, costUsd, uncachedCostUsd };
    const day = localDay(Date.parse(e.at));
    const totals = this.loadTotals();
    let id: number;
    try {
      id = this.db.transaction(() => {
        const merge = reconcileUsage(this.db, accounted);
        if (merge.remove) {
          this.revision += 1;
          const old = merge.remove;
          const key = merge.removeKey!;
          const total = totals.get(key);
          if (total) {
            const counts = accountedUsage(old);
            for (const k of Object.keys(counts) as (keyof typeof counts)[]) total[k] -= counts[k];
            this.statements.saveTotal.run(key, JSON.stringify(total));
          }
        }
        if (merge.skip) return merge.id ?? 0;
        const row = addToTotals(totals, e);
        if (this.importing) preserveImportedCost(row, accounted);
        this.statements.saveTotal.run(storedTotalKey(row), JSON.stringify(row));
        const id = Number(this.statements.insertRequest.run(day, e.failed ? 1 : 0, JSON.stringify(e)).lastInsertRowid);
        rememberUsage(this.db, accounted, id);
        this.statements.linkIdentity.run(id, identityKey(e));
        if (!this.importing && matchLegacyUsage(this.db, [identityKey(e)])) {
          this.totals = null; this.revision += 1;
          return (this.statements.identityRow.get(identityKey(e)) as { row_id: number }).row_id;
        }
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
      const row = this.statements.conversation.get(e.sessionId, e.model) as RequestRow | undefined;
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

  /**
   * Coverage starts at the first proxy record carrying a session or response ID; earlier client-log rows are excluded.
   */
  coverage(): ProxyCoverage {
    const first = (this.db.prepare("SELECT value FROM meta WHERE key = 'first-matchable-proxy'").get() as { value: string } | undefined)?.value ?? null;
    if (first === null) return { since: null, clients: [] };
    const since = Date.parse(first);
    const rows = this.db.prepare(`SELECT provider, client,
      count(*) AS requests, sum(matched) AS viaProxy FROM usage_identities INDEXED BY usage_coverage_groups
      WHERE source = 'client-log' AND at >= ? GROUP BY provider, client ORDER BY requests DESC`)
      .all(first) as ProxyCoverage['clients'];
    return { since, clients: rows };
  }

  totalsList(): ActivityDayTotal[] {
    return dailyTotals(this.loadTotals().values());
  }

  /** Totals for the latest `days` local days; null returns all. */
  buckets(days: number | null): ActivityBucket[] {
    const all = [...this.loadTotals().values()];
    if (days === null) return all.map(toBucket);
    const wanted = new Set(lastDays(Date.now(), days));
    return all.filter((t) => wanted.has(t.day)).map(toBucket);
  }

  /** Both ranges use one clock and share bucket objects from the same totals. */
  bucketSnapshot(days: number | null): ActivityBucketSnapshot {
    const now = Date.now();
    const heldDays = days === null ? null : new Set(lastDays(now, days));
    const forecastDays = new Set(lastDays(now, RHYTHM_LOOKBACK_DAYS));
    const held: ActivityBucket[] = [];
    const forecast: ActivityBucket[] = [];
    for (const total of this.loadTotals().values()) {
      const inHeld = heldDays === null || heldDays.has(total.day);
      const inForecast = forecastDays.has(total.day);
      if (!inHeld && !inForecast) continue;
      const bucket = toBucket(total);
      if (inHeld) held.push(bucket);
      if (inForecast) forecast.push(bucket);
    }
    return { held, forecast };
  }

  /** Deletes requests outside the retention setting; their totals stay. */
  prune(): void {
    this.prunedOn = localDay(Date.now());
    const oldest = oldestKeptDay(Date.now(), this.config.retentionDays);
    this.statements.prune.run(oldest);
    this.db.pragma('incremental_vacuum');
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM requests; DELETE FROM activity_totals; DELETE FROM usage_identities; DELETE FROM meta WHERE key = 'first-matchable-proxy';");
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
    this.checkpoints.clear();
  }

  private loadTotals(): Map<string, ActivityTotal> {
    if (this.totals) return this.totals;
    this.totals = readTotals(this.db);
    return this.totals;
  }
}
