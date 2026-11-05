import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import type { ActivityEvent } from '@shared/types';
import { openActivityDb } from './activityDb';
import { ActivityLog } from './activityStore';
import { emptyCounts } from '@shared/activityCounts';
import { totalKey } from './activityTotals';

const event = (at: Date, requestId: string, source: ActivityEvent['source']): ActivityEvent => ({
  at: at.toISOString(), requestId, source, upstreamId: requestId, sessionId: 'session',
  provider: 'claude', model: 'opus', client: 'claude-cli', authIndex: null,
  selectionId: null, stream: true, failed: false, statusCode: null, error: null,
  latencyMs: 0, ttftMs: null, inputTokens: 10, outputTokens: 5, cachedTokens: 0,
  cacheWriteTokens: 0, movedFrom: null, userAgent: null,
});

it('reuses fixed statements across events and clear, with fresh statements after reopening', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-statements-'));
  const log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 30 });
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    log.append(event(new Date(), 'warmup', 'proxy'));
    prepare.mockClear();
    log.append(event(new Date(), 'next', 'proxy'));
    log.importBatch('log', 'checkpoint', [event(new Date(), 'client', 'client-log')]);
    expect(prepare).not.toHaveBeenCalled();
    log.clear();
    log.append(event(new Date(), 'after-clear', 'proxy'));
    expect(prepare).not.toHaveBeenCalled();
    log.close();
    log.append(event(new Date(), 'after-reopen', 'proxy'));
    expect(prepare).toHaveBeenCalled();
    expect(log.totalsList().reduce((sum, t) => sum + t.requests, 0)).toBe(2);
  } finally { prepare.mockRestore(); log.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('rolls back a failed batch with reused statements, then retries without double counting', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-statement-rollback-'));
  const file = path.join(dir, 'activity.db');
  const key = 'ab'.repeat(32);
  const log = new ActivityLog({ activityDb: file, legacyActivityDir: path.join(dir, 'legacy'), databaseKey: key, retentionDays: 30 });
  try {
    log.importBatch('log', 'before', [event(new Date(), 'original', 'client-log')]);
    const db = openActivityDb(file, key);
    try { db.exec(`CREATE TRIGGER fail_batch BEFORE INSERT ON requests WHEN json_extract(NEW.event, '$.requestId') = 'fail' BEGIN SELECT RAISE(ABORT, 'batch failed'); END`); }
    finally { db.close(); }
    const batch = [event(new Date(), 'first', 'client-log'), event(new Date(), 'fail', 'client-log')];
    expect(() => log.importBatch('log', 'after', batch)).toThrow('batch failed');
    expect(log.checkpoint('log')).toBe('before');
    expect(log.totalsList().reduce((sum, t) => sum + t.requests, 0)).toBe(1);
    const retryDb = openActivityDb(file, key);
    try { retryDb.exec('DROP TRIGGER fail_batch'); } finally { retryDb.close(); }
    log.importBatch('log', 'after', batch);
    log.importBatch('log', 'replayed', batch);
    expect(log.checkpoint('log')).toBe('replayed');
    expect(log.daySummaries().reduce((sum, d) => sum + d.requests, 0)).toBe(3);
    expect(log.totalsList().reduce((sum, t) => sum + t.requests, 0)).toBe(3);
    log.close();
    expect(log.checkpoint('log')).toBe('replayed');
    expect(log.totalsList().reduce((sum, t) => sum + t.requests, 0)).toBe(3);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('reads both bucket ranges with one clock across midnight, DST and legacy daily totals', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-bucket-snapshot-'));
  const file = path.join(dir, 'activity.db');
  const key = 'ab'.repeat(32);
  const log = new ActivityLog({ activityDb: file, legacyActivityDir: path.join(dir, 'legacy'), databaseKey: key, retentionDays: 90 });
  const clock = vi.spyOn(Date, 'now');
  try {
    for (const at of ['2026-08-01T12:00:00-07:00', '2026-10-12T12:00:00-07:00', '2026-10-13T12:00:00-07:00', '2026-11-01T01:15:00-07:00', '2026-11-01T01:15:00-08:00', '2026-11-02T00:00:00-08:00']) {
      log.append(event(new Date(at), at, 'proxy'));
    }
    log.close();
    const db = openActivityDb(file, key);
    const legacy = { day: '2026-10-31', provider: 'claude', authIndex: null, model: 'opus', client: null, source: 'proxy' as const, ...emptyCounts(), requests: 5 };
    try { db.prepare('INSERT INTO activity_totals VALUES (?, ?)').run(totalKey(legacy), JSON.stringify(legacy)); }
    finally { db.close(); }
    log.buckets(null);
    for (const at of ['2026-11-01T23:59:59.999-08:00', '2026-11-02T00:00:00-08:00', '2026-11-01T01:30:00-07:00', '2026-11-01T01:30:00-08:00']) {
      clock.mockReturnValue(Date.parse(at));
      for (const days of [31, 90, null]) {
        clock.mockClear();
        const result = log.bucketSnapshot(days);
        expect(clock).toHaveBeenCalledOnce();
        expect(result).toEqual({ held: log.buckets(days), forecast: log.buckets(21) });
        expect(result.forecast.filter((b) => b.start === Date.parse('2026-11-01T01:00:00-07:00') || b.start === Date.parse('2026-11-01T01:00:00-08:00'))).toHaveLength(2);
        expect(result.forecast.some((b) => b.wholeDay && b.requests === 5)).toBe(true);
      }
    }
  } finally { clock.mockRestore(); log.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});

it('keeps the database usable and retries maintenance next open after VACUUM fails', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-vacuum-'));
  const exec = Database.prototype.exec;
  const failure = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
    if (sql === 'VACUUM') throw new Error('disk full');
    return exec.call(this, sql);
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const db = openActivityDb(path.join(dir, 'activity.db'), 'ab'.repeat(32));
    expect(db.prepare("SELECT 1 FROM meta WHERE key = 'incremental-vacuum-enabled'").get()).toBeUndefined();
    db.exec("INSERT INTO meta VALUES ('usable', '1')");
    expect(error).toHaveBeenCalledTimes(1);
    db.close();
    failure.mockRestore();
    const reopened = openActivityDb(path.join(dir, 'activity.db'), 'ab'.repeat(32));
    expect(reopened.prepare("SELECT 1 FROM meta WHERE key = 'incremental-vacuum-enabled'").get()).toBeDefined();
    reopened.close();
  } finally { failure.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('prunes every imported batch after the daily prune while preserving accounting and checkpoints', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-storage-'));
  const log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 1 });
  try {
    log.append(event(new Date(), 'today', 'proxy'));
    const old = new Date();
    old.setDate(old.getDate() - 2);
    log.importBatch('log', 'checkpoint', [event(old, 'expired', 'client-log')]);
    expect(log.days()).toHaveLength(1);
    expect(log.totalsList().reduce((sum, t) => sum + t.requests, 0)).toBe(2);
    expect(log.checkpoint('log')).toBe('checkpoint');
    log.importBatch('log', 'checkpoint2', [event(old, 'expired', 'client-log')]);
    expect(log.totalsList().reduce((sum, t) => sum + t.requests, 0)).toBe(2);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('compacts old identities without losing cross-restart matching or recorded totals', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-compact-'));
  const file = path.join(dir, 'activity.db');
  const key = 'ab'.repeat(32);
  const log = new ActivityLog({ activityDb: file, legacyActivityDir: path.join(dir, 'legacy'), databaseKey: key, retentionDays: 30 });
  try {
    const imported = event(new Date(), 'imported', 'client-log');
    log.append(imported);
    log.close();
    let db = openActivityDb(file, key);
    db.prepare("UPDATE usage_identities SET event = json_set(event, '$.at', ?, '$.source', ?, '$.provider', ?, '$.client', ?, '$.upstreamId', ?)")
      .run(imported.at, imported.source, imported.provider, imported.client, imported.upstreamId);
    db.exec("DELETE FROM meta WHERE key IN ('compact-usage-identities', 'incremental-vacuum-enabled')");
    db.close();
    db = openActivityDb(file, key);
    expect(db.pragma('auto_vacuum', { simple: true })).toBe(2);
    const row = db.prepare('SELECT event FROM usage_identities').get() as { event: string };
    expect(JSON.parse(row.event)).not.toHaveProperty('at');
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
    log.append({ ...imported, requestId: 'proxy', source: 'proxy' });
    expect(log.totalsList().reduce((sum, t) => sum + t.requests, 0)).toBe(1);
    expect(log.coverage().clients).toEqual([{ provider: 'claude', client: 'claude-cli', requests: 1, viaProxy: 1 }]);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});
