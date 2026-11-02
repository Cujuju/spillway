import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openActivityDb } from './activityDb';
it('backfills legacy coverage columns and caches the first matchable time once', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-backfill-'));
  const file = path.join(dir, 'activity.db');
  const key = 'ab'.repeat(32);
  let db = openActivityDb(file, key);
  try {
    db.exec('DROP INDEX usage_coverage; DROP INDEX usage_coverage_groups; ALTER TABLE usage_identities DROP COLUMN at; ALTER TABLE usage_identities DROP COLUMN provider; ALTER TABLE usage_identities DROP COLUMN client;');
    const event = { at: '2026-10-29T00:00:00Z', provider: 'claude', client: 'claude-cli', sessionId: 'claude:s1' };
    db.prepare('INSERT INTO usage_identities (key, event, row_id, source) VALUES (?, ?, ?, ?)').run('proxy:p1', JSON.stringify(event), 1, 'proxy');
    db.close();
    db = openActivityDb(file, key);
    expect(db.prepare('SELECT at, provider, client FROM usage_identities').get()).toEqual({ at: event.at, provider: event.provider, client: event.client });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'first-matchable-proxy'").get()).toEqual({ value: event.at });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_coverage'").get()).toBeDefined();
    db.close();
    db = openActivityDb(file, key);
    expect(db.prepare('SELECT count(*) AS n FROM usage_identities').get()).toEqual({ n: 1 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('answers coverage from a covering index', async () => {
  const { ActivityLog } = await import('./activityStore');
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-coverage-'));
  const file = path.join(dir, 'activity.db');
  const key = 'ab'.repeat(32);
  const db = openActivityDb(file, key);
  const log = new ActivityLog({ activityDb: file, legacyActivityDir: path.join(dir, 'legacy'), databaseKey: key, retentionDays: 30 });
  try {
    db.exec(`INSERT INTO usage_identities (key, event, row_id, matched, source, at, provider, client) VALUES
      ('client:unmatched', '{}', 0, 0, 'client-log', '2026-10-29T00:00:00Z', 'claude', 'claude-cli'),
      ('client:matched', '{}', 0, 1, 'client-log', '2026-10-29T00:00:00Z', 'claude', 'claude-cli');
      INSERT INTO meta VALUES ('first-matchable-proxy', '2026-10-28T00:00:00Z');`);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT provider, client, count(*) AS requests, sum(matched) AS viaProxy FROM usage_identities INDEXED BY usage_coverage_groups WHERE source = 'client-log' AND at >= ? GROUP BY provider, client ORDER BY requests DESC").all('2026-10-28T00:00:00Z') as { detail: string }[];
    expect(plan.some((row) => row.detail.includes('COVERING INDEX usage_coverage_groups'))).toBe(true);
    expect(log.coverage().clients).toEqual([{ provider: 'claude', client: 'claude-cli', requests: 2, viaProxy: 1 }]);
  } finally { log.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
