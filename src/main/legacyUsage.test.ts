import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { ActivityEvent } from '@shared/types';
import { ActivityLog } from './activityStore';
import { openActivityDb } from './activityDb';
import { backfillLegacyUsage } from './legacyUsage';
import { addToTotals, storedTotalKey } from './activityTotals';
import { rememberUsage } from './usageLedger';
import { USAGE_MATCH_TOLERANCE_MS } from './usageMerge';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-legacy-'));
const key = 'ab'.repeat(32);
const boundary = '2026-10-28T00:00:00.000Z';
let sequence = 0;
const logs: ActivityLog[] = [];
afterEach(() => { for (const log of logs.splice(0)) log.close(); vi.restoreAllMocks(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const event = (patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at: '2026-10-27T23:59:00.000Z', requestId: `r${sequence++}`, selectionId: null, upstreamId: null, source: 'proxy',
  provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a', stream: true, failed: false, statusCode: null,
  error: null, latencyMs: 10, ttftMs: 1, inputTokens: 100, outputTokens: 20, cachedTokens: 10, cacheWriteTokens: 2,
  sessionId: null, movedFrom: null, userAgent: null, client: null, ...patch,
});
function setup(events: ActivityEvent[]) {
  const file = path.join(dir, `activity-${sequence++}.db`);
  const db = openActivityDb(file, key);
  const totals = new Map();
  db.transaction(() => {
    for (const e of events) {
      const row = addToTotals(totals, e);
      db.prepare('INSERT OR REPLACE INTO activity_totals VALUES (?, ?)').run(storedTotalKey(row), JSON.stringify(row));
      const id = Number(db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, 0, ?)').run(row.day, JSON.stringify(e)).lastInsertRowid);
      rememberUsage(db, e, id);
    }
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('first-matchable-proxy', ?)").run(boundary);
    db.exec("INSERT OR REPLACE INTO meta VALUES ('usage-ledger-seeded', '1')");
  })();
  const log = new ActivityLog({ activityDb: file, databaseKey: key, legacyActivityDir: path.join(dir, 'missing'), retentionDays: 365 });
  logs.push(log);
  return { db, log };
}
const requests = (log: ActivityLog) => log.buckets(null).reduce((n, t) => n + t.requests, 0);

it.each(['claude', 'codex'] as const)('backfills a unique %s boundary-crossing pair once and keeps proxy accounting', (provider) => {
  const proxy = event({ provider });
  const client = event({ provider, source: 'client-log', authIndex: null, client: 'cli', sessionId: 's', upstreamId: 'u',
    at: new Date(Date.parse(proxy.at) + USAGE_MATCH_TOLERANCE_MS).toISOString() });
  const { db, log } = setup([proxy, client]);
  try {
    expect(requests(log)).toBe(1);
    expect(log.day('2026-10-27')).toHaveLength(1);
    expect(log.day('2026-10-28')).toHaveLength(0);
    expect(log.buckets(null).filter((t) => t.source === 'client-log').every((t) => t.requests === 0 && t.inputTokens === 0 && t.costUsd === 0)).toBe(true);
    backfillLegacyUsage(db);
    log.close();
    expect(requests(log)).toBe(1);
    expect(db.prepare('SELECT sum(matched) AS n FROM usage_identities').get()).toEqual({ n: 2 });
  } finally { db.close(); }
});

it.each(['proxy', 'client-log'] as const)('leaves ambiguous %s candidates unmatched', (source) => {
  const { db, log } = setup([event(), event({ source: 'client-log' }), event({ source })]);
  try { expect(requests(log)).toBe(3); expect(db.prepare('SELECT sum(matched) AS n FROM usage_identities').get()).toEqual({ n: 0 }); }
  finally { db.close(); }
});

it.each([{ sessionId: 's' }, { upstreamId: 'u' }, { at: boundary }])('excludes ineligible proxy rows: %j', (patch) => {
  const { db, log } = setup([event(patch), event({ source: 'client-log', at: boundary })]);
  try { expect(requests(log)).toBe(2); } finally { db.close(); }
});

it('matches imports arriving after proxy history and judges all batch candidates before matching', () => {
  const { db, log } = setup([event(), event({ inputTokens: 200 })]);
  try {
    expect(requests(log)).toBe(2);
    log.importBatch('client', '1', [event({ source: 'client-log', inputTokens: 200 })]);
    expect(requests(log)).toBe(2);
    log.importBatch('client', '2', [event({ source: 'client-log' }), event({ source: 'client-log' })]);
    expect(requests(log)).toBe(4);
  } finally { db.close(); }
});

it('rolls back a failed backfill and leaves reads usable for a later retry', () => {
  const { db, log } = setup([event(), event({ source: 'client-log' })]);
  try {
    db.exec("CREATE TRIGGER fail_match BEFORE UPDATE ON usage_identities BEGIN SELECT RAISE(ABORT, 'test'); END");
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(requests(log)).toBe(2);
    expect(db.prepare("SELECT 1 FROM meta WHERE key = 'legacy-usage-matched'").get()).toBeUndefined();
    db.exec('DROP TRIGGER fail_match');
    log.close();
    expect(requests(log)).toBe(1);
  } finally { db.close(); }
});
