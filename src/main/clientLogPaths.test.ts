import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { clientLogKey, isClientLogFile } from './clientLogPaths';
import { openActivityDb } from './activityDb';
import { ActivityLog } from './activityStore';

it('normalizes Windows checkpoint keys across case, separators and dot segments', () => {
  expect(clientLogKey('C:/Logs/../LOGS/Session.jsonl', 'win32')).toBe(clientLogKey('c:\\logs\\session.jsonl', 'win32'));
  expect(clientLogKey('/Logs/Session.jsonl', 'darwin')).not.toBe(clientLogKey('/logs/session.jsonl', 'darwin'));
});

it.each(['a.jsonl', 'a.jsonl.zst', 'a.txt'])('shares the log extension contract for %s', (name) => {
  expect(isClientLogFile(name)).toBe(name !== 'a.txt');
});

it.skipIf(process.platform !== 'win32')('rekeys legacy rows transactionally and shares the key with the cache and DB', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-keys-'));
  const config = { activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 30 };
  const file = path.join(dir, 'Session.jsonl');
  const state = JSON.stringify({ mtime: 100, offset: 30 });
  const log = new ActivityLog(config);
  try {
    const db = openActivityDb(config.activityDb, config.databaseKey);
    db.prepare("DELETE FROM meta WHERE key = 'checkpoint-paths-normalized'").run();
    db.prepare('INSERT INTO client_log_checkpoints VALUES (?, ?)').run(file.toUpperCase().replaceAll('\\', '/'), state);
    db.prepare('INSERT INTO client_log_checkpoints VALUES (?, ?)').run(file, JSON.stringify({ mtime: 100, offset: 10 }));
    db.close();
    expect(log.checkpoint(file.toLowerCase())).toBe(state);
    expect(log.checkpoint(file.toUpperCase())).toBe(state);
    log.importBatch(file.toUpperCase(), 'updated', []);
    expect(log.checkpoint(file.toLowerCase())).toBe('updated');
    log.close();
    const reopened = openActivityDb(config.activityDb, config.databaseKey);
    expect(reopened.prepare('SELECT * FROM client_log_checkpoints').all()).toEqual([{ path: clientLogKey(file), state: 'updated' }]);
    reopened.close();
  } finally { log.close(); await rm(dir, { recursive: true, force: true }); }
});
