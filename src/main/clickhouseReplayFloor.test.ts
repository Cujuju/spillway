import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { openActivityDb } from './activityDb';
import { ActivityStorage } from './activityStorage';
import { runReplayFloorMode, snapshotReplayFloor } from './clickhouseReplayFloor';

vi.mock('electron', () => ({
  app: {
    commandLine: { getSwitchValue: vi.fn(() => ''), hasSwitch: vi.fn(() => false) },
    requestSingleInstanceLock: vi.fn(() => true), whenReady: vi.fn(async () => undefined),
    getPath: vi.fn(() => ''), exit: vi.fn(),
  },
  safeStorage: { isAsyncEncryptionAvailable: vi.fn(async () => false) },
}));

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

function profile() {
  const directory = mkdtempSync(join(tmpdir(), 'spillway-history-profile-'));
  dirs.push(directory);
  const file = join(directory, 'activity.db'), key = randomBytes(32).toString('hex');
  const db = openActivityDb(file, key);
  const { sourceId } = db.prepare('SELECT source_id AS sourceId FROM clickhouse_export').get() as { sourceId: string };
  return { directory, file, key, db, sourceId };
}

it('uses uncheckpointed encrypted WAL rows from a crashed writer', async () => {
  const { file, key, db } = profile();
  db.close();
  const source = randomBytes(16).toString('hex');
  const child = spawnSync(process.execPath, ['-e', `
    const { writeSync } = require('node:fs');
    const Database = require('better-sqlite3-multiple-ciphers');
    const [file,key,source] = process.argv.slice(1);
    const db = new Database(file);
    db.pragma("cipher='chacha20'");
    db.pragma("hexkey='" + key + "'");
    db.pragma('journal_mode=WAL');
    db.pragma('wal_autocheckpoint=0');
    db.transaction(() => {
      db.prepare('UPDATE clickhouse_export SET source_id=?').run(source);
      db.exec("INSERT INTO archive_pieces(id,bytes) VALUES(42,X'01')");
    })();
    writeSync(1, 'committed');
    process.kill(process.pid, 'SIGKILL');
  `, file, key, source], { encoding: 'utf8', timeout: 15_000 });
  expect(child.stdout).toBe('committed');
  const main = readFileSync(file), wal = readFileSync(file + '-wal');
  expect(wal.length).toBeGreaterThan(0);
  expect(await snapshotReplayFloor(file, key)).toEqual({ version: 1, sourceId: source, firstReplayablePieceSeq: '42' });
  expect(readFileSync(file)).toEqual(main);
  expect(readFileSync(file + '-wal')).toEqual(wal);
});

it('pairs an empty archive with its next AUTOINCREMENT ID and leaves the profile alone', async () => {
  const { directory, file, key, db, sourceId } = profile();
  db.exec("INSERT INTO archive_pieces(id,bytes) VALUES(41,X'01'); DELETE FROM archive_pieces");
  db.close();
  const secretsFile = join(directory, 'secrets.bin');
  const secrets = JSON.stringify({ clientApiKey: randomBytes(32).toString('hex'), databaseKey: key });
  writeFileSync(secretsFile, secrets);
  const reportFile = join(directory, 'replay.json');
  vi.mocked(app.commandLine.getSwitchValue).mockReturnValue(reportFile);
  vi.mocked(app.getPath).mockReturnValue(directory);
  const before = readFileSync(file);
  await runReplayFloorMode();
  expect(app.exit).toHaveBeenCalledWith(0);
  expect(JSON.parse(readFileSync(reportFile, 'utf8'))).toEqual({ version: 1, sourceId, firstReplayablePieceSeq: '42' });
  expect(readFileSync(file)).toEqual(before);
  expect(readFileSync(secretsFile, 'utf8')).toBe(secrets);
  expect(existsSync(file + '-wal')).toBe(false);
});

it.each(['pending', 'cleanup'] as const)('refuses a replay snapshot with a %s storage move', async (phase) => {
  const { directory, db } = profile();
  db.close();
  const operation = phase === 'cleanup' ? { source: null } : {
    directory: join(directory, 'prospective'), id: '11111111-1111-1111-1111-111111111111', parentIdentity: 'fixture',
  };
  const state = JSON.stringify({ active: null, [phase]: operation });
  const file = join(directory, 'activity-storage.json');
  writeFileSync(file, state);
  await expect(new ActivityStorage(directory).snapshotDirectory()).rejects.toThrow('Finish the storage move');
  expect(readFileSync(file, 'utf8')).toBe(state);
});
