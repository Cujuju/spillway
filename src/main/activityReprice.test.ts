import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { addEvent, emptyCounts, localDay } from '@shared/activityCounts';
import { priceTableSnapshot } from '@shared/modelPrices';
import type { ActivityEvent } from '@shared/types';
import { importLegacyFiles, openActivityDb, type Db } from './activityDb';
import { repriceActivity } from './activityReprice';
import { addToTotals, readTotalRows, storedTotalKey, type ActivityTotal } from './activityTotals';
import { identityKey, rememberUsage } from './usageLedger';
import { exportActivityEvents } from './activityTransfer';
import { ActivityLog } from './activityStore';
import { matchLegacyUsage } from './legacyUsage';
import { TraceStore } from './traceStore';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-reprice-'));
const key = 'ab'.repeat(32);
let db: Db;
let sequence = 0;
beforeEach(() => { db = openActivityDb(path.join(dir, `${sequence++}.db`), key); repriceActivity(db); });
afterEach(() => { db.close(); vi.restoreAllMocks(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const event = (at: string, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at, requestId: `r${sequence++}`, selectionId: null, upstreamId: null, source: 'proxy', provider: 'claude', model: 'claude-sonnet-5-5',
  authIndex: 'a', stream: true, failed: false, statusCode: null, error: null, latencyMs: 10, ttftMs: 1, inputTokens: 100,
  outputTokens: 20, cachedTokens: 1_000_000, cacheWriteTokens: 2, sessionId: 'session', movedFrom: null, userAgent: null, client: 'cli', ...patch,
});
const costs = (e: ActivityEvent) => { const c = emptyCounts(); addEvent(c, e); return c; };
const saveSnapshot = (snapshot: string) => db.prepare("UPDATE meta SET value = ? WHERE key = 'activity-price-table'").run(snapshot);
const stored = (e: ActivityEvent, retain = true): ActivityTotal => {
  const total = addToTotals(new Map(), e);
  total.costUsd = 99;
  total.uncachedCostUsd = 199;
  db.prepare('INSERT INTO activity_totals VALUES (?, ?)').run(storedTotalKey(total), JSON.stringify(total));
  if (retain) {
    const id = Number(db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, 0, ?)').run(localDay(Date.parse(e.at)), JSON.stringify(e)).lastInsertRowid);
    rememberUsage(db, { ...e, costUsd: total.costUsd, uncachedCostUsd: total.uncachedCostUsd }, id);
  }
  return total;
};
const reopen = () => { const file = db.name; db.close(); db = openActivityDb(file, key); repriceActivity(db); };
const totals = () => readTotalRows(db).map(({ total }) => total);

it('does only one meta read when the snapshot is unchanged', () => {
  stored(event('2026-10-08T12:00:00Z'));
  const prepare = vi.spyOn(db, 'prepare');
  repriceActivity(db);
  expect(prepare.mock.calls).toEqual([['SELECT value FROM meta WHERE key = ?']]);
});

it('reprices dated changes per request, preserving earlier and pruned totals and all counts', () => {
  const table = JSON.parse(priceTableSnapshot());
  table['claude-sonnet-5-5'] = [table['claude-sonnet-5-5'][0]];
  saveSnapshot(JSON.stringify(table));
  const before = stored(event('2026-10-06T12:00:00Z'));
  const changed = event('2026-10-07T12:00:00Z', { model: 'routed', effectiveModel: ' CLAUDE-SONNET-5-5-20261001 ' });
  const old = stored(changed);
  const second = { ...changed, at: '2026-10-07T12:30:00Z', requestId: 'second', cachedTokens: 10 };
  addEvent(old, second);
  db.prepare('UPDATE activity_totals SET total = ? WHERE key = ?').run(JSON.stringify(old), storedTotalKey(old));
  const id = Number(db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, 0, ?)').run(old.day, JSON.stringify(second)).lastInsertRowid);
  rememberUsage(db, second, id);
  const partner = { ...second, requestId: 'partner', source: 'client-log' as const };
  rememberUsage(db, partner, id);
  db.exec('UPDATE usage_identities SET matched = 1');
  const pruned = stored(event('2026-10-08T12:00:00Z'), false);
  const prepare = vi.spyOn(db, 'prepare');
  repriceActivity(db);
  expect(prepare.mock.calls.filter(([sql]) => /SELECT id, day, event FROM requests/i.test(sql))).toHaveLength(2);
  const after = totals();
  expect(after).toContainEqual(before);
  expect(after).toContainEqual(pruned);
  expect(after).toContainEqual({ ...old, costUsd: costs(changed).costUsd + costs(second).costUsd,
    uncachedCostUsd: costs(changed).uncachedCostUsd + costs(second).uncachedCostUsd });
  const partnerRow = db.prepare('SELECT event FROM usage_identities WHERE key = ?').get(identityKey(partner)) as { event: string };
  expect(JSON.parse(partnerRow.event).costUsd).toBe(costs(second).costUsd);
  const exported = [...exportActivityEvents(db)].find((e) => e.requestId === changed.requestId)!;
  expect(exported.costUsd).toBe(costs(changed).costUsd);
  expect(exported.uncachedCostUsd).toBe(costs(changed).uncachedCostUsd);
  const trace = new TraceStore(db).attempts({ nodeId: 'session:session', from: '2026-10-07T00:00:00Z', to: '2026-10-08T00:00:00Z' });
  expect(trace.attempts.find((e) => e.requestId === changed.requestId)!.costUsd).toBe(costs(changed).costUsd);
});

it('reprices missing snapshots after opening, including unpriced and long-context requests', () => {
  const e = event('2026-10-08T12:00:00Z', { model: 'claude-haiku-5-5' });
  const old = stored(e);
  old.unpricedRequests = 1;
  db.prepare('UPDATE activity_totals SET total = ?').run(JSON.stringify(old));
  db.prepare("DELETE FROM meta WHERE key = 'activity-price-table'").run();
  reopen();
  expect(totals()).toEqual([{ ...old, costUsd: costs(e).costUsd, uncachedCostUsd: costs(e).uncachedCostUsd, unpricedRequests: 0 }]);
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  reopen();
  expect(prepare.mock.calls.filter(([sql]) => /SELECT .*FROM requests/i.test(sql))).toHaveLength(0);
});

it('keeps partially retained totals and their accounting costs together', () => {
  const e = event('2026-10-08T12:00:00Z');
  const old = stored(e);
  old.requests++;
  db.prepare('UPDATE activity_totals SET total = ?').run(JSON.stringify(old));
  db.prepare("DELETE FROM meta WHERE key = 'activity-price-table'").run();
  repriceActivity(db);
  expect(totals()).toEqual([old]);
  const row = db.prepare('SELECT event FROM usage_identities WHERE key = ?').get(identityKey(e)) as { event: string };
  expect(JSON.parse(row.event).costUsd).toBe(old.costUsd);
});

it('skips equal costs independently for totals, requests, owners and matched partners', () => {
  const e = event('2026-10-08T12:00:00Z');
  const c = costs(e);
  stored(e);
  const id = (db.prepare('SELECT id FROM requests').get() as { id: number }).id;
  const partner = { ...e, source: 'client-log' as const, requestId: 'equal-partner' };
  rememberUsage(db, partner, id);
  db.exec('UPDATE usage_identities SET matched = 1');
  db.prepare('UPDATE activity_totals SET total = ?').run(JSON.stringify(addToTotals(new Map(), e)));
  db.prepare('UPDATE requests SET event = ?').run(JSON.stringify({ ...e, costUsd: c.costUsd, uncachedCostUsd: c.uncachedCostUsd }));
  db.prepare("UPDATE usage_identities SET event = json_set(event, '$.costUsd', ?, '$.uncachedCostUsd', ?)").run(c.costUsd, c.uncachedCostUsd);
  const changedRows = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const repriceWrites = () => {
    db.prepare("DELETE FROM meta WHERE key = 'activity-price-table'").run();
    const before = changedRows();
    repriceActivity(db);
    return changedRows() - before;
  };
  expect(repriceWrites()).toBe(1); // Snapshot only.
  db.prepare("UPDATE usage_identities SET event = json_set(event, '$.costUsd', 99) WHERE key = ?").run(identityKey(partner));
  expect(repriceWrites()).toBe(2); // Partner and snapshot, despite unchanged request and total.
  db.prepare("UPDATE usage_identities SET event = json_set(event, '$.costUsd', 99) WHERE key = ?").run(identityKey(e));
  expect(repriceWrites()).toBe(2);
  db.prepare("UPDATE requests SET event = json_set(event, '$.costUsd', null)").run();
  expect(repriceWrites()).toBe(2);
});

/** Encrypted fixture creation and repricing can exceed the default timeout on CI. */
const LARGE_REPRICE_TIMEOUT_MS = 60_000;
it.each([5, 100])('reprices 150,000 requests and 300,000 identities (%i% changed) with bounded indexed reads', (percentChanged) => {
  const requestCount = 150_000;
  const percentScale = 100;
  const bytesPerMiB = 1024 * 1024;
  const e = event('2026-10-08T12:00:00Z', { costUsd: 99, uncachedCostUsd: 199 } as Partial<ActivityEvent>);
  const total = stored(e, false);
  for (const k of Object.keys(emptyCounts()) as (keyof ReturnType<typeof emptyCounts>)[]) total[k] *= requestCount;
  db.prepare('UPDATE activity_totals SET total = ?').run(JSON.stringify(total));
  const currentCosts = costs(e);
  total.costUsd = requestCount * (99 * percentChanged + currentCosts.costUsd * (percentScale - percentChanged)) / percentScale;
  total.uncachedCostUsd = requestCount * (199 * percentChanged + currentCosts.uncachedCostUsd * (percentScale - percentChanged)) / percentScale;
  db.prepare('UPDATE activity_totals SET total = ?').run(JSON.stringify(total));
  const insert = db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, 0, ?)');
  db.transaction(() => {
    for (let n = 0; n < requestCount; n++) {
      const proxy = { ...e, requestId: `bulk-${n}`, ...(n % percentScale < percentChanged ? {} : { costUsd: currentCosts.costUsd, uncachedCostUsd: currentCosts.uncachedCostUsd }) };
      const id = Number(insert.run(total.day, JSON.stringify(proxy)).lastInsertRowid);
      rememberUsage(db, proxy, id);
      rememberUsage(db, { ...proxy, source: 'client-log', requestId: `client-${n}` }, id);
    }
    db.exec('UPDATE usage_identities SET matched = 1');
    db.prepare("DELETE FROM meta WHERE key = 'activity-price-table'").run();
  })();
  const prepare = vi.spyOn(db, 'prepare');
  const started = performance.now();
  repriceActivity(db);
  console.info(`150k ${percentChanged}% reprice: ${Math.round(performance.now() - started)} ms; peak RSS ${Math.round(process.resourceUsage().maxRSS * 1024 / bytesPerMiB)} MiB`);
  const scans = prepare.mock.calls.filter(([sql]) => /SELECT id, day, event FROM requests/i.test(sql));
  expect(scans).toHaveLength(1);
  const lookups = prepare.mock.calls.filter(([sql]) => /SELECT .*FROM usage_identities WHERE matched/i.test(sql));
  expect(lookups).toHaveLength(1);
  for (const [sql] of lookups) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(total.day) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes('usage_identity_row'))).toBe(true);
  }
  expect(prepare.mock.calls.some(([sql]) => /SELECT .*FROM usage_identities WHERE row_id/i.test(sql))).toBe(false);
  prepare.mockRestore();
  expect(totals()[0]!.costUsd).toBeCloseTo(costs(e).costUsd * requestCount, 5);
}, LARGE_REPRICE_TIMEOUT_MS);

it('invalidates transferred costs in the import transaction and reprices after reopening', () => {
  const file = path.join(dir, `transfer-${sequence++}.db`);
  const log = new ActivityLog({ activityDb: file, legacyActivityDir: path.join(dir, 'absent'), databaseKey: key, retentionDays: 30 });
  const e = event(new Date().toISOString());
  try { log.importEvents([{ ...e, costUsd: 99, uncachedCostUsd: 199 }]); }
  finally { log.close(); }
  const imported = openActivityDb(file, key);
  try {
    repriceActivity(imported);
    expect(readTotalRows(imported)[0]!.total.costUsd).toBe(costs(e).costUsd);
    const row = imported.prepare('SELECT event FROM usage_identities WHERE key = ?').get(identityKey(e)) as { event: string };
    expect(JSON.parse(row.event).costUsd).toBe(costs(e).costUsd);
  } finally { imported.close(); }
});

it('invalidates legacy files imported after open repricing', () => {
  const e = event('2026-10-08T12:00:00Z');
  const old = stored(e, false);
  db.exec('DELETE FROM activity_totals');
  const legacy = path.join(dir, `legacy-${sequence++}`);
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, `${old.day}.jsonl`), JSON.stringify(e));
  const { start: _start, ...baseline } = old;
  writeFileSync(path.join(legacy, 'daily-totals.json'), JSON.stringify([baseline]));
  importLegacyFiles(db, legacy);
  expect(db.prepare("SELECT value FROM meta WHERE key = 'activity-price-table'").get()).toBeUndefined();
  reopen();
  expect(totals()[0]!.costUsd).toBe(costs(e).costUsd);
});

it('reprices legacy matched partners while rejecting reused row ids', () => {
  const e = event('2026-10-08T12:00:00Z', { sessionId: null, upstreamId: null });
  stored(e);
  const owner = db.prepare('SELECT row_id FROM usage_identities WHERE key = ?').get(identityKey(e)) as { row_id: number };
  const partner = { ...e, source: 'client-log' as const, sessionId: 'client-session', upstreamId: 'client-upstream', requestId: 'legacy-client' };
  rememberUsage(db, { ...partner, costUsd: 99 }, owner.row_id);
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('first-matchable-proxy', ?)").run('2026-10-09T00:00:00Z');
  expect(matchLegacyUsage(db)).toBe(1);
  const stale = { ...partner, requestId: 'stale', at: '2026-09-01T12:00:00Z' };
  rememberUsage(db, { ...stale, costUsd: 99 }, owner.row_id);
  db.exec('UPDATE usage_identities SET matched = 1');
  db.prepare("DELETE FROM meta WHERE key = 'activity-price-table'").run();
  repriceActivity(db);
  const read = db.prepare('SELECT event FROM usage_identities WHERE key = ?');
  expect(JSON.parse((read.get(identityKey(partner)) as { event: string }).event).costUsd).toBe(costs(e).costUsd);
  expect(JSON.parse((read.get(identityKey(stale)) as { event: string }).event).costUsd).toBe(99);
});
