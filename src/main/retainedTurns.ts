import type { ActivityEvent } from '@shared/types';
import { IDENTITY_BY_ROW_INDEX, PARENT_SESSION_SQL, type Db } from './activityDb';
import { connectionStatements } from './connectionStatements';
import { identityKeySql } from './usageLedger';

/** A retained request with the cost its usage identity counted, when it has one. */
export type Request = ActivityEvent & { costUsd?: number };
export interface Turn { first: Request; requests: Request[] }
export interface Grouped { turns: Turn[]; excluded: Request[] }

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
const covers = (held: DayWindow, wanted: DayWindow) => held.from <= wanted.from && held.to >= wanted.to;

interface Row { id: number; event: string; time: number | null; cost: string | null }
// A request's identity has its key and its row. `->` keeps the cost's JSON text, so JavaScript parses the digits itself.
const ROWS_SQL = `SELECT requests.id, requests.event, julianday(json_extract(requests.event, '$.at')) AS time, i.event -> '$.costUsd' AS cost
  FROM requests LEFT JOIN usage_identities AS i INDEXED BY ${IDENTITY_BY_ROW_INDEX} ON i.row_id = requests.id AND i.key = ${identityKeySql('requests.event')}`;
/** Each must search an index: a scan of `requests` or `usage_identities` grows with the whole table. */
export const RETAINED_TURNS_SQL = {
  inWindow: `${ROWS_SQL} WHERE requests.day BETWEEN ? AND ?`,
  // Counted from the index alone, so sessions wholly inside the window cost no second read of their rows.
  sessionSizes: `SELECT value AS id, (SELECT count(*) FROM requests WHERE json_extract(event, '$.sessionId') = value) AS requests FROM json_each(?)`,
  // The session expression leads requests_by_conversation and requests_trace_session.
  restOfSessions: `${ROWS_SQL} WHERE json_extract(requests.event, '$.sessionId') IN (SELECT value FROM json_each(?)) AND (requests.day < ? OR requests.day > ?)`,
  childSessions: `SELECT DISTINCT json_extract(event, '$.sessionId') AS id FROM requests WHERE ${PARENT_SESSION_SQL} IN (SELECT value FROM json_each(?))`,
};
const statementsFor = connectionStatements({ ...RETAINED_TURNS_SQL, changes: 'SELECT total_changes() AS n' });

/** The window's requests plus the rest of every session tree they touch, oldest first: turns start before the window and subagents outlast it. */
export function loadRequests(db: Db, window: DayWindow): Request[] {
  const statements = statementsFor(db);
  const loaded: { id: number; time: number | null; request: Request }[] = [];
  const fetched = new Set<string>(), held = new Map<string, number>();
  let wanted = new Set<string>();
  const want = (session: string | null | undefined) => { if (session && !fetched.has(session)) wanted.add(session); };
  const take = (rows: Row[]) => {
    for (const r of rows) {
      const request = JSON.parse(r.event) as Request;
      if (r.cost !== null) request.costUsd = JSON.parse(r.cost) as number;
      loaded.push({ id: r.id, time: r.time, request });
      if (request.sessionId) held.set(request.sessionId, (held.get(request.sessionId) ?? 0) + 1);
      want(request.sessionId); want(request.parentSessionId);
    }
  };
  take(statements.inWindow.all(window.from, window.to) as Row[]);
  while (wanted.size) {
    const sessions = JSON.stringify([...wanted]);
    for (const s of wanted) fetched.add(s);
    wanted = new Set();
    const split = (statements.sessionSizes.all(sessions) as { id: string; requests: number }[]).filter((s) => s.requests > (held.get(s.id) ?? 0)).map((s) => s.id);
    if (split.length) take(statements.restOfSessions.all(JSON.stringify(split), window.from, window.to) as Row[]);
    for (const child of statements.childSessions.all(sessions) as { id: string | null }[]) want(child.id);
  }
  // SQLite's own time value and row id: the order the report has always read requests in.
  loaded.sort((a, b) => a.time === b.time ? a.id - b.id : a.time === null ? -1 : b.time === null ? 1 : a.time - b.time);
  return loaded.map((l) => l.request);
}

// Parsed requests take memory in proportion to the table; five minutes spans reading the tab and changing its range.
const IDLE_RELEASE_MS = 5 * 60_000;

/** The last loaded day window's grouped turns, reused for ranges inside it until the database changes or goes unread. */
export class RetainedTurns {
  private held: { db: Db; version: string; window: DayWindow; grouped: Grouped } | null = null;
  private release: NodeJS.Timeout | undefined;

  /** Every turn and excluded request that can count for a query over [from, to]; callers still filter by time. */
  get(db: Db, from: number, to: number): Grouped {
    const window = dayWindow(from, to);
    // data_version moves on other connections' commits, total_changes on this one's: together, any write.
    const version = `${String(db.pragma('data_version', { simple: true }))}:${(statementsFor(db).changes.get() as { n: number }).n}`;
    if (this.held?.db !== db || this.held.version !== version || !covers(this.held.window, window)) {
      this.held = { db, version, window, grouped: group(loadRequests(db, window)) };
    }
    clearTimeout(this.release);
    this.release = setTimeout(() => this.clear(), IDLE_RELEASE_MS);
    this.release.unref();
    return this.held.grouped;
  }

  clear(): void {
    clearTimeout(this.release);
    this.held = null;
  }
}
