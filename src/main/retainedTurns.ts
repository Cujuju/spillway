import { inScope, type ActivityScope } from '@shared/activityScope';
import { stepHasThinking, type ActivityEvent } from '@shared/types';
import { IDENTITY_BY_ROW_INDEX, PARENT_SESSION_SQL, type Db } from './activityDb';
import { connectionStatements } from './connectionStatements';
import { identityKeySql } from './usageLedger';

/** A retained request with the cost its usage identity counted, when it has one. */
export type Request = ActivityEvent & { costUsd?: number };
export interface Turn { first: Request; requests: Request[] }
export interface Grouped { turns: Turn[]; excluded: Request[] }

/** Scoped requests for a turn whose root request is itself in scope; empty when the root is filtered out. */
export function scopedTurnRequests(turn: Turn, scope: ActivityScope): Request[] {
  return inScope(scope, turn.first) ? turn.requests.filter((e) => inScope(scope, e)) : [];
}

/** Counts non-compaction steps and thinking steps for one turn's scoped requests; null when any step's thinking presence is unknown. */
export function measureTurnSteps(requests: readonly Request[]): { steps: number; thinkingSteps: number | null } {
  let steps = 0;
  let thinkingSteps: number | null = 0;
  for (const e of requests) {
    if (e.sessionKind === 'compaction') continue;
    steps += 1;
    if (thinkingSteps !== null) {
      const has = stepHasThinking(e);
      if (has === null) thinkingSteps = null;
      else if (has) thinkingSteps += 1;
    }
  }
  return { steps, thinkingSteps };
}

/** Requests must arrive oldest first. Subagent and compaction sessions join the parent turn active at their first request. */
export function group(requests: Request[]): Grouped {
  const sessions = new Map<string, Request[]>();
  const excluded: Request[] = [];
  for (const e of requests) {
    if (!e.sessionId) { excluded.push(e); continue; }
    const list = sessions.get(e.sessionId) ?? [];
    list.push(e); sessions.set(e.sessionId, list);
  }
  const attached = (list: Request[]) => list.some((e) => e.sessionKind === 'subagent' || e.sessionKind === 'compaction' && e.parentSessionId);
  const roots = new Map<string, Turn[]>();
  const turns: Turn[] = [];
  for (const [id, list] of sessions) {
    if (attached(list)) continue;
    let active: Turn | undefined;
    for (const e of list) {
      if (!e.turnKey) { excluded.push(e); active = undefined; continue; }
      if (!active || active.first.turnKey !== e.turnKey) {
        active = { first: e, requests: [] }; turns.push(active);
        const own = roots.get(id) ?? []; own.push(active); roots.set(id, own);
      }
      active.requests.push(e);
    }
  }
  for (const [id, list] of sessions) {
    if (!attached(list)) continue;
    const seen = new Set([id]);
    let parent = list.find((e) => e.parentSessionId)?.parentSessionId;
    while (parent && !roots.has(parent) && !seen.has(parent)) {
      seen.add(parent); parent = sessions.get(parent)?.find((e) => e.parentSessionId)?.parentSessionId;
    }
    const active = parent ? roots.get(parent)?.findLast((t) => Date.parse(t.first.at) <= Date.parse(list[0]!.at)) : undefined;
    if (active) active.requests.push(...list); else excluded.push(...list);
  }
  return { turns, excluded };
}

const HOUR_MS = 3_600_000;
// Zone offsets span UTC-12 to UTC+14, so a time's stored local day is the UTC date of a time in that span, whichever zone recorded it.
const MAX_ZONE_BEHIND_UTC_MS = 12 * HOUR_MS;
const MAX_ZONE_AHEAD_UTC_MS = 14 * HOUR_MS;
// Day keys sort like time only while years have four digits.
const ORDERED_DAYS_FROM_MS = Date.UTC(1000, 0, 1);
const ORDERED_DAYS_UNTIL_MS = Date.UTC(10_000, 0, 1);
/** Inclusive `requests.day` bounds. */
export interface DayWindow { from: string; to: string }
/** Bounds that sort around every stored day, including an unparsable time's. */
const EVERY_DAY: DayWindow = { from: '', to: '\uffff' };
const DAY_KEY_LENGTH = 'YYYY-MM-DD'.length;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, DAY_KEY_LENGTH);

/** The stored days that can hold a request timed inside [from, to]. */
export function dayWindow(from: number, to: number): DayWindow {
  const first = from - MAX_ZONE_BEHIND_UTC_MS, last = to + MAX_ZONE_AHEAD_UTC_MS;
  return first >= ORDERED_DAYS_FROM_MS && last < ORDERED_DAYS_UNTIL_MS ? { from: utcDay(first), to: utcDay(last) } : EVERY_DAY;
}

interface Row { id: number; day: string; event: string; time: number | null; cost: string | null }
interface LoadedRow { id: number; time: number | null; inWindow: boolean; request: Request }
// A request's identity has its key and its row. `->` keeps the cost's JSON text, so JavaScript parses the digits itself.
const ROWS_SQL = `SELECT requests.id, requests.day, requests.event, julianday(json_extract(requests.event, '$.at')) AS time, i.event -> '$.costUsd' AS cost
  FROM requests LEFT JOIN usage_identities AS i INDEXED BY ${IDENTITY_BY_ROW_INDEX} ON i.row_id = requests.id AND i.key = ${identityKeySql('requests.event')}`;
/** Each must search an index: a scan of `requests` or `usage_identities` grows with the whole table. */
export const RETAINED_TURNS_SQL = {
  inWindow: `${ROWS_SQL} WHERE requests.day BETWEEN ? AND ?`,
  // Counted from the index alone, so sessions wholly inside the window cost no second read of their rows.
  sessionSizes: `SELECT value AS id, (SELECT count(*) FROM requests WHERE json_extract(event, '$.sessionId') = value) AS requests FROM json_each(?)`,
  // The session expression leads requests_by_conversation and requests_trace_session.
  restOfSessions: `${ROWS_SQL} WHERE json_extract(requests.event, '$.sessionId') IN (SELECT value FROM json_each(?)) AND (requests.day < ? OR requests.day > ?)`,
  childSessions: `SELECT DISTINCT json_extract(event, '$.sessionId') AS id FROM requests WHERE ${PARENT_SESSION_SQL} IN (SELECT value FROM json_each(?))`,
  changedRows: `${ROWS_SQL} WHERE requests.id IN (SELECT value FROM json_each(?))`,
};
const statementsFor = connectionStatements(RETAINED_TURNS_SQL);

interface Session { rows: Set<LoadedRow>; neighbors: Map<string, number>; anchors: number }

/** The window and every session connected to it, including parents and children outside its days. */
class LoadedRequests {
  private statements;
  private rows = new Map<number, LoadedRow>();
  private ordered: LoadedRow[] = [];
  private sessions = new Map<string, Session>();
  private pending = new Set<string>();

  constructor(db: Db, readonly window: DayWindow) {
    this.statements = statementsFor(db);
    for (const row of this.statements.inWindow.all(window.from, window.to) as Row[]) this.add(this.decode(row, true));
    this.expand();
  }

  private decode(row: Row, inWindow: boolean): LoadedRow {
    const request = JSON.parse(row.event) as Request;
    if (row.cost !== null) request.costUsd = JSON.parse(row.cost) as number;
    return { id: row.id, time: row.time, request, inWindow };
  }

  private session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = { rows: new Set(), neighbors: new Map(), anchors: 0 };
      this.sessions.set(id, session);
      this.pending.add(id);
    }
    return session;
  }

  private add(row: LoadedRow): void {
    this.rows.set(row.id, row);
    this.ordered.push(row);
    const { sessionId, parentSessionId } = row.request;
    if (sessionId) this.session(sessionId).rows.add(row);
    const anchor = sessionId || parentSessionId;
    if (row.inWindow && anchor) this.session(anchor).anchors++;
    this.link(sessionId, parentSessionId, 1);
  }

  private link(child: string | null, parent: string | null | undefined, delta: 1 | -1): boolean {
    if (!child || !parent || child === parent) return false;
    const a = this.session(child).neighbors, b = this.session(parent).neighbors;
    const count = (a.get(parent) ?? 0) + delta;
    if (count) { a.set(parent, count); b.set(child, count); }
    else { a.delete(parent); b.delete(child); }
    return count === 0;
  }

  private expand(): void {
    while (this.pending.size) {
      const ids = JSON.stringify([...this.pending]);
      this.pending.clear();
      const { from, to } = this.window;
      const sizes = this.statements.sessionSizes.all(ids) as { id: string; requests: number }[];
      const split = sizes.filter((s) => s.requests > this.sessions.get(s.id)!.rows.size).map((s) => s.id);
      if (split.length) {
        for (const row of this.statements.restOfSessions.all(JSON.stringify(split), from, to) as Row[]) {
          if (!this.rows.has(row.id)) this.add(this.decode(row, false));
        }
      }
      for (const child of this.statements.childSessions.all(ids) as { id: string | null }[]) if (child.id) this.session(child.id);
    }
  }

  apply(ids: number[]): boolean {
    const previous = new Set(ids.flatMap((id) => { const row = this.rows.get(id); return row ? [row] : []; }));
    let added = false;
    const { from, to } = this.window;
    // Add replacements first so unchanged anchors and links never drop to zero.
    for (const row of this.statements.changedRows.all(JSON.stringify(ids)) as Row[]) {
      const loaded = this.decode(row, row.day >= from && row.day <= to);
      const cached = this.rows.get(row.id);
      if (cached && cached.time === loaded.time && cached.inWindow === loaded.inWindow &&
        JSON.stringify(cached.request) === JSON.stringify(loaded.request)) {
        previous.delete(cached);
        continue;
      }
      const { sessionId, parentSessionId } = loaded.request;
      if (loaded.inWindow || sessionId && (this.sessions.has(sessionId) || parentSessionId && this.sessions.has(parentSessionId))) {
        this.add(loaded);
        added = true;
      }
    }
    if (!added && !previous.size) return false;
    const detached = new Set<string>();
    for (const row of previous) {
      if (this.rows.get(row.id) === row) this.rows.delete(row.id);
      const { sessionId, parentSessionId } = row.request;
      if (sessionId) this.session(sessionId).rows.delete(row);
      const anchor = sessionId || parentSessionId;
      if (row.inWindow && anchor && --this.session(anchor).anchors === 0) detached.add(anchor);
      if (this.link(sessionId, parentSessionId, -1)) { detached.add(sessionId!); detached.add(parentSessionId!); }
    }
    this.expand();
    this.evictDetached(detached);
    return true;
  }

  private evictDetached(candidates: Set<string>): void {
    const anchored = new Set<string>();
    for (const id of candidates) {
      if (!this.sessions.has(id) || anchored.has(id)) continue;
      const visited = new Set([id]);
      // Set iteration also visits neighbors added during the walk.
      for (const next of visited) {
        const session = this.sessions.get(next)!;
        if (session.anchors || anchored.has(next)) {
          for (const found of visited) anchored.add(found);
          break;
        }
        for (const neighbor of session.neighbors.keys()) visited.add(neighbor);
      }
      if (anchored.has(id)) continue;
      for (const found of visited) {
        for (const row of this.sessions.get(found)!.rows) this.rows.delete(row.id);
        this.sessions.delete(found);
      }
    }
  }

  requests(): Request[] {
    // Keep the previously sorted prefix and order new rows by SQLite's time and row id.
    this.ordered = this.ordered.filter((r) => this.rows.get(r.id) === r);
    this.ordered.sort((a, b) => a.time === b.time ? a.id - b.id : a.time === null ? -1 : b.time === null ? 1 : a.time - b.time);
    return this.ordered.map((r) => r.request);
  }
}

export function loadRetainedTurns(db: Db, from: number, to: number): Grouped {
  const load = () => group(new LoadedRequests(db, dayWindow(from, to)).requests());
  return db.inTransaction ? load() : db.transaction(load)();
}

// Beyond this many changed rows, a full reload is cheaper than applying a bulk import row by row.
export const MAX_INCREMENTAL_ROWS = 1024;
let nextChangeLog = 0;

class ChangedRequests {
  private table = `retained_turn_changes_${nextChangeLog++}`;
  private triggers = ['requests', 'usage_identities'].flatMap((table) => ['INSERT', 'UPDATE', 'DELETE'].map((op) => ({
    name: `${this.table}_${table}_${op}`, table, op,
  })));
  private drain;

  constructor(private db: Db) {
    db.exec(`CREATE TEMP TABLE ${this.table} (id INTEGER NOT NULL UNIQUE)`);
    // Identity relinks must use UPDATE (or ON CONFLICT DO UPDATE) to log both row IDs. REPLACE skips the DELETE trigger with recursive triggers off.
    for (const { name, table, op } of this.triggers) {
      const column = table === 'requests' ? 'id' : 'row_id';
      const refs = op === 'UPDATE' ? ['OLD', 'NEW'] : [op === 'INSERT' ? 'NEW' : 'OLD'];
      // The indexed maximum caps the log at one overflow row. Emptying the table resets the rowids.
      const record = refs.map((side) => `INSERT INTO ${this.table} (id) SELECT ${side}.${column}
        WHERE coalesce((SELECT max(rowid) FROM ${this.table}), 0) <= ${MAX_INCREMENTAL_ROWS}
          AND NOT EXISTS (SELECT 1 FROM ${this.table} WHERE id = ${side}.${column});`).join('\n');
      db.exec(`CREATE TEMP TRIGGER ${name} AFTER ${op} ON main.${table} BEGIN ${record} END`);
    }
    this.drain = db.prepare(`DELETE FROM temp.${this.table} RETURNING id`);
  }

  take(): number[] { return (this.drain.all() as { id: number }[]).map((r) => r.id); }

  drop(): void {
    if (!this.db.open) return;
    this.db.exec(`${this.triggers.map(({ name }) => `DROP TRIGGER temp.${name};`).join('\n')} DROP TABLE temp.${this.table}`);
  }
}

// Parsed requests take memory in proportion to the table; five minutes spans reading the tab and changing its range.
const IDLE_RELEASE_MS = 5 * 60_000;

/** The last loaded day window's grouped turns, updated from writes on this connection. */
export class RetainedTurns {
  private held: { db: Db; version: number; loaded: LoadedRequests; changes: ChangedRequests; grouped: Grouped } | null = null;
  private release: NodeJS.Timeout | undefined;

  /** Every turn and excluded request that can count for a query over [from, to]; callers still filter by time. */
  get(db: Db, from: number, to: number): Grouped {
    // A rollback can restore rows and the TEMP log together, but cannot roll back the JavaScript cache.
    if (db.inTransaction) return loadRetainedTurns(db, from, to);
    const window = dayWindow(from, to);
    if (this.held && this.held.db !== db) this.clear();
    try {
      this.held = db.transaction(() => {
        const version = Number(db.pragma('data_version', { simple: true }));
        const held = this.held;
        const changed = held?.changes.take() ?? [];
        if (held && held.version === version && changed.length <= MAX_INCREMENTAL_ROWS &&
          held.loaded.window.from === window.from && held.loaded.window.to === window.to) {
          if (changed.length && held.loaded.apply(changed)) held.grouped = group(held.loaded.requests());
          return held;
        }
        const loaded = new LoadedRequests(db, window);
        const grouped = group(loaded.requests());
        return { db, version, loaded, grouped, changes: held?.changes ?? new ChangedRequests(db) };
      })();
    } catch (error) {
      this.clear();
      throw error;
    }
    clearTimeout(this.release);
    this.release = setTimeout(() => this.clear(), IDLE_RELEASE_MS);
    this.release.unref();
    return this.held!.grouped;
  }

  clear(): void {
    clearTimeout(this.release);
    this.held?.changes.drop();
    this.held = null;
  }
}
