import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { antigravityLogContext, antigravityOAuthTokenPath, antigravitySummaryDbPath, clientLogKey, isClientLogFile, shouldSkipClientLogPath } from './clientLogPaths';
import { openActivityDb } from './activityDb';
import { ActivityLog } from './activityStore';

it('normalizes Windows checkpoint keys across case, separators and dot segments', () => {
  expect(clientLogKey('C:/Logs/../LOGS/Session.jsonl', 'win32')).toBe(clientLogKey('c:\\logs\\session.jsonl', 'win32'));
  expect(clientLogKey('/Logs/Session.jsonl', 'darwin')).not.toBe(clientLogKey('/logs/session.jsonl', 'darwin'));
});

it.each(['a.jsonl', 'a.jsonl.zst', 'a.txt'])('shares the log extension contract for %s', (name) => {
  expect(isClientLogFile(name)).toBe(name !== 'a.txt');
});

it('skips Antigravity artifact subtrees using case-insensitive path segments', () => {
  for (const file of [
    'C:\\BRAIN\\session\\.SYSTEM_GENERATED\\STEPS\\1', 'brain/id/.system_generated/messages',
    'brain/id/.system_generated/tasks', 'brain/id/.system_generated/undelivered/transcript.jsonl',
    'logs/chunks', 'logs/media/transcript.jsonl', 'brain/logs/scratch', 'brain/id/.user_uploaded/file',
  ]) {
    expect(shouldSkipClientLogPath(file, 'antigravity')).toBe(true);
    expect(shouldSkipClientLogPath(file, 'claude')).toBe(false);
    expect(shouldSkipClientLogPath(file, 'codex')).toBe(false);
  }
  for (const file of ['logs/transcript.jsonl', 'logs/transcript.jsonl.zst', 'brain/id/scratchpad/transcript.jsonl',
    'brain/id/other/scratch/transcript.jsonl', 'logs/chunks/../transcript.jsonl']) {
    expect(shouldSkipClientLogPath(file, 'antigravity')).toBe(false);
  }
});

it('limits Antigravity log matching to canonical transcript files and derives session and client', () => {
  expect(isClientLogFile('transcript.jsonl', 'antigravity')).toBe(true);
  expect(isClientLogFile('C:\\x\\logs\\transcript.jsonl.zst', 'antigravity')).toBe(true);
  expect(isClientLogFile('transcript_full.jsonl', 'antigravity')).toBe(false);
  expect(isClientLogFile('chunks/transcript/00000000.jsonl', 'antigravity')).toBe(false);
  expect(isClientLogFile('history.jsonl', 'antigravity')).toBe(false);
  expect(antigravityLogContext('C:\\Users\\u\\.t3\\userdata\\providers\\antigravity\\abc\\antigravity-acp\\brain\\conv-1\\.system_generated\\logs\\transcript.jsonl'))
    .toEqual({ session: 'conv-1', client: 'antigravity-acp' });
  expect(antigravityLogContext('/home/u/.gemini/antigravity-cli/brain/conv-2/.system_generated/logs/transcript.jsonl'))
    .toEqual({ session: 'conv-2', client: 'antigravity-cli' });
  expect(antigravityLogContext('/home/u/.gemini/antigravity/brain/conv-3/.system_generated/logs/transcript.jsonl'))
    .toEqual({ session: 'conv-3', client: 'antigravity' });
  expect(antigravityOAuthTokenPath(path.join(tmpdir(), 'antigravity-acp', 'brain', 'conv-1', '.system_generated', 'logs', 'transcript.jsonl')))
    .toBe(path.join(tmpdir(), 'antigravity-acp', 'antigravity-oauth-token'));
  expect(antigravityOAuthTokenPath(path.join(tmpdir(), 'other', 'transcript.jsonl'))).toBeNull();
  expect(antigravitySummaryDbPath(path.join(tmpdir(), 'antigravity-acp', 'brain', 'conv-1', '.system_generated', 'logs', 'transcript.jsonl')))
    .toBe(path.join(tmpdir(), 'antigravity-acp', 'conversation_summaries.db'));
  expect(antigravitySummaryDbPath(path.join(tmpdir(), 'other', 'transcript.jsonl'))).toBeNull();
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
