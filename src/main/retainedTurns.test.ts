import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localDay } from '@shared/activityCounts';
import type { ActivityEvent } from '@shared/types';
import { openActivityDb, openKeyed, type Db } from './activityDb';
import { thinkingActivity } from './activityThinking';
import { thinkingEvent } from './activityThinkingFixtures';
import { MAX_INCREMENTAL_ROWS, RETAINED_TURNS_SQL, RetainedTurns, type Grouped } from './retainedTurns';
import { identityKey } from './usageLedger';

const KEY = 'ab'.repeat(32);
const dir = mkdtempSync(path.join(tmpdir(), 'spillway-retained-turns-'));
const minute = 60_000, day = 24 * 60 * minute;
const noon = Date.UTC(2026, 5, 10, 12);
const q = { from: noon - minute, to: noon + 10 * minute, scope: { accounts: null, clients: null } };
let db: Db, other: Db, retained: RetainedTurns, sequence = 0;

beforeEach(() => {
  const file = path.join(dir, `${sequence++}.db`);
  db = openActivityDb(file, KEY);
  other = openKeyed(file, KEY);
  retained = new RetainedTurns();
});
afterEach(() => { retained.clear(); other.close(); db.close(); vi.restoreAllMocks(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function insert(at: number, sessionId: string | null, patch: Partial<ActivityEvent> = {}, conn = db) {
  const event = thinkingEvent(at, { sessionId, turnKey: 'first', thinkingTokens: 100, ...patch });
  const id = Number(conn.prepare('INSERT INTO requests (day, failed, event) VALUES (?, 0, ?)').run(localDay(at), JSON.stringify(event)).lastInsertRowid);
  return { id, event };
}

function warm(from = q.from, to = q.to) {
  const prepare = vi.spyOn(db, 'prepare');
  const before = retained.get(db, from, to);
  const watch = (sql: string) => vi.spyOn(prepare.mock.results[prepare.mock.calls.findIndex(([query]) => query === sql)]!.value, 'all');
  return { before, window: watch(RETAINED_TURNS_SQL.inWindow), changed: watch(RETAINED_TURNS_SQL.changedRows), rest: watch(RETAINED_TURNS_SQL.restOfSessions) };
}

function expectFresh(): Grouped {
  const fresh = new RetainedTurns();
  try {
    const result = retained.get(db, q.from, q.to);
    expect(result).toStrictEqual(fresh.get(other, q.from, q.to));
    expect(thinkingActivity(db, q, [], retained)).toStrictEqual(thinkingActivity(other, q, [], fresh));
    return result;
  } finally { fresh.clear(); }
}

it('reloads the day window when switching to a narrower range', () => {
  const earlier = noon - 4 * day;
  insert(earlier, 'earlier');
  insert(noon, 'root');
  const { window } = warm(earlier, q.to);

  expectFresh();
  expect(window).toHaveBeenCalledTimes(1);
});

it('reuses the grouped object after a request outside the window and its session trees', () => {
  insert(noon, 'root');
  const { before, window, changed } = warm();
  const { id } = insert(noon + 4 * day, 'outside');

  expect(expectFresh()).toBe(before);
  expect(window).not.toHaveBeenCalled();
  expect(changed.mock.calls).toStrictEqual([[JSON.stringify([id])]]);
});

it('reuses the grouped object after unchanged request and identity updates', () => {
  const { id, event } = insert(noon, 'priced');
  const key = identityKey(event);
  db.prepare('INSERT INTO usage_identities (key, event, row_id) VALUES (?, ?, ?)').run(key, JSON.stringify({ costUsd: 1 }), id);
  const { before, window, changed } = warm();

  db.prepare('UPDATE requests SET event = event WHERE id = ?').run(id);
  expect(expectFresh()).toBe(before);
  db.prepare('UPDATE usage_identities SET event = event WHERE key = ?').run(key);
  expect(expectFresh()).toBe(before);

  expect(window).not.toHaveBeenCalled();
  expect(changed.mock.calls).toStrictEqual([[JSON.stringify([id])], [JSON.stringify([id])]]);
});

it('applies appends in row batches and expands new session trees across the window', () => {
  insert(noon, 'root');
  const far = noon - 4 * day;
  insert(far, 'far-root');
  insert(far + minute, 'far-agent', { sessionKind: 'subagent', parentSessionId: 'far-root' });
  insert(far + 2 * minute, 'far-sibling', { sessionKind: 'subagent', parentSessionId: 'far-root' });
  insert(far + 3 * minute, 'far-child', { sessionKind: 'subagent', parentSessionId: null });
  const { before, window, changed } = warm();

  const more = insert(noon, 'root'); // Equal SQLite times order by row id.
  const next = insert(noon + minute, 'root', { turnKey: 'next' });
  const child = insert(noon + 4 * day, 'child', { sessionKind: 'subagent', parentSessionId: 'root' });
  const chain = insert(noon + 2 * minute, 'far-child', { sessionKind: 'subagent', parentSessionId: 'far-agent' });
  const result = expectFresh();

  expect(result.turns[1]!.first).toBe(before.turns[0]!.first);
  expect(result.turns[1]!.requests.at(-1)).toStrictEqual(more.event);
  expect(result.turns[0]!.requests).toContainEqual(chain.event);
  expect(result.turns[2]!.requests).toContainEqual(child.event);
  expect(window).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(new Set(JSON.parse(changed.mock.calls[0]![0] as string) as number[])).toStrictEqual(new Set([more.id, next.id, child.id, chain.id]));
});

it('replaces moved requests and evicts a tree when its final window anchor is deleted', () => {
  const anchor = insert(noon, 'root');
  const kept = insert(noon + minute, 'kept');
  const moved = insert(noon + 2 * minute, 'root');
  const outside = noon + 4 * day;
  const tail = insert(outside, 'root');
  insert(outside, 'child', { sessionKind: 'subagent', parentSessionId: 'root' });
  const { before, window, rest } = warm();

  db.prepare("UPDATE requests SET event = json_set(event, '$.sessionId', 'kept', '$.turnKey', 'next') WHERE id = ?").run(moved.id);
  db.prepare('DELETE FROM requests WHERE id = ?').run(anchor.id);
  const movedAway = expectFresh();
  expect(movedAway.turns).toHaveLength(2);
  expect(movedAway.turns[0]!.first).toBe(before.turns[1]!.first);
  expect(movedAway.turns[0]!.first).toStrictEqual(kept.event);
  expect(rest).not.toHaveBeenCalled();

  db.prepare("UPDATE requests SET day = ?, event = json_set(event, '$.at', ?) WHERE id = ?").run(localDay(noon), new Date(noon).toISOString(), tail.id);
  expect(expectFresh().turns[0]!.requests).toHaveLength(2);
  expect(window).not.toHaveBeenCalled();
});

it('evicts a detached branch while the original root stays in the window', () => {
  insert(noon, 'root');
  const link = insert(noon + 4 * day, 'child', { sessionKind: 'subagent', parentSessionId: 'root' });
  insert(noon + 4 * day + minute, 'child', { sessionKind: 'subagent' });
  const { window } = warm();
  db.prepare("UPDATE requests SET event = json_remove(event, '$.parentSessionId') WHERE id = ?").run(link.id);
  expect(expectFresh().turns[0]!.requests).toHaveLength(1);
  expect(window).not.toHaveBeenCalled();
});

it('updates costs on identity insert, update and delete without reading the window', () => {
  const { id, event } = insert(noon, 'priced');
  const { before, window, changed, rest } = warm();
  const key = identityKey(event);
  const insertedCost = 1.25, updatedCost = 2.5;
  db.prepare('INSERT INTO usage_identities (key, event, row_id) VALUES (?, ?, ?)').run(key, JSON.stringify({ costUsd: insertedCost }), id);
  expect(expectFresh().turns[0]!.first.costUsd).toBe(insertedCost);
  db.prepare("UPDATE usage_identities SET event = json_set(event, '$.costUsd', ?) WHERE key = ?").run(updatedCost, key);
  expect(expectFresh().turns[0]!.first.costUsd).toBe(updatedCost);
  db.prepare('DELETE FROM usage_identities WHERE key = ?').run(key);
  expect(expectFresh()).toStrictEqual(before);
  expect(window).not.toHaveBeenCalled();
  expect(rest).not.toHaveBeenCalled();
  expect(changed.mock.calls).toStrictEqual(Array.from({ length: 3 }, () => [JSON.stringify([id])]));
});

it('preserves the grouped object on unrelated writes and after a rolled-back request write', () => {
  insert(noon, 'root');
  const { before, window, changed } = warm();
  db.exec("INSERT INTO meta VALUES ('unrelated', 'value')");
  db.exec('BEGIN');
  insert(noon + minute, 'rolled-back');
  db.exec('ROLLBACK');
  expect(expectFresh()).toBe(before);
  expect(window).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it('keeps uncommitted rows out of the retained cache', () => {
  insert(noon, 'root');
  const before = retained.get(db, q.from, q.to);
  db.exec('BEGIN');
  try {
    insert(noon + minute, 'pending');
    expect(retained.get(db, q.from, q.to).turns).toHaveLength(2);
  } finally { db.exec('ROLLBACK'); }
  expect(expectFresh()).toBe(before);
});

it('reloads the window after a second connection commits', () => {
  insert(noon, 'root');
  const { before, window, changed } = warm();
  insert(noon + minute, 'other-root', {}, other);
  const result = expectFresh();
  expect(result.turns).toHaveLength(2);
  expect(result.turns[0]!.first).not.toBe(before.turns[0]!.first);
  expect(window).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
});

const tempObjects = () => db.prepare("SELECT name, type FROM sqlite_temp_master WHERE name GLOB 'retained_turn_changes_*' ORDER BY type").all() as { name: string; type: string }[];

it('caps the change log and reloads after a bulk write crosses the threshold', () => {
  insert(noon, 'root');
  const { window, changed } = warm();
  const bulkSize = MAX_INCREMENTAL_ROWS * 2;
  db.transaction(() => {
    for (let n = 0; n < bulkSize; n++) insert(noon + minute, 'root');
  })();
  const table = tempObjects().find((o) => o.type === 'table')!.name;
  expect(db.prepare(`SELECT count(*) AS n FROM temp.${table}`).get()).toEqual({ n: MAX_INCREMENTAL_ROWS + 1 });
  expect(expectFresh().turns[0]!.requests).toHaveLength(bulkSize + 1);
  expect(window).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();

  insert(noon + 2 * minute, 'root');
  expect(expectFresh().turns[0]!.requests).toHaveLength(bulkSize + 2);
  expect(window).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('drops every change trigger and the TEMP table on clear', () => {
  expect(tempObjects()).toEqual([]);
  retained.get(db, q.from, q.to);
  expect(tempObjects().map((o) => o.type)).toEqual(['table', 'trigger', 'trigger', 'trigger', 'trigger', 'trigger', 'trigger']);
  retained.clear();
  expect(tempObjects()).toEqual([]);
  insert(noon, 'root');
  expect(expectFresh().turns).toHaveLength(1);
});

it('drops the TEMP objects when the cache is released on idle', () => {
  vi.useFakeTimers();
  try {
    retained.get(db, q.from, q.to);
    expect(tempObjects()).not.toHaveLength(0);
    vi.runOnlyPendingTimers();
    expect(tempObjects()).toHaveLength(0);
  } finally { vi.useRealTimers(); }
});
