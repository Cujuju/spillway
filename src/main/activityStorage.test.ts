import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import type { ActivityEvent } from '@shared/types';
import { openActivityDb } from './activityDb';
import { ActivityLog } from './activityStore';

const event = (at: Date, requestId: string, source: ActivityEvent['source']): ActivityEvent => ({
  at: at.toISOString(), requestId, source, upstreamId: requestId, sessionId: 'session',
  provider: 'claude', model: 'opus', client: 'claude-cli', authIndex: null,
  selectionId: null, stream: true, failed: false, statusCode: null, error: null,
  latencyMs: 0, ttftMs: null, inputTokens: 10, outputTokens: 5, cachedTokens: 0,
  cacheWriteTokens: 0, movedFrom: null, userAgent: null,
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
