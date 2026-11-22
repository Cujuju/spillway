import { app } from 'electron';
import { copyFile, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { openKeyed } from './activityDb';
import { ACTIVITY_FILES } from './activityStorage';
import { hasTransferSwitch, TRANSFER_EXIT } from './dataTransfer';
import { RAW_PIECE_NAMESPACE } from './clickhouseWire';
import { activityStorage } from './paths';
import { readExistingDatabaseKey } from './settingsStore';

export const REPLAY_FLOOR_SWITCH = 'clickhouse-replay-floor';

export async function snapshotReplayFloor(database: string, key: string) {
  await using staging = await mkdtempDisposable(join(tmpdir(), 'spillway-replay-floor-'));
  const snapshot = join(staging.path, ACTIVITY_FILES.database);
  await copyFile(database, snapshot);
  try { await copyFile(database + '-wal', snapshot + '-wal'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = openKeyed(snapshot, key, true);
  try {
    return db.transaction(() => {
      const source = db.prepare('SELECT source_id AS sourceId FROM clickhouse_export WHERE singleton=1').get() as { sourceId: string } | undefined;
      if (!source || !/^[\da-f]{32}$/.test(source.sourceId)) throw new Error('Invalid ClickHouse source ID');
      const retained = db.prepare('SELECT CAST(min(id) AS TEXT) AS id FROM archive_pieces').get() as { id: string | null };
      const sequence = db.prepare("SELECT CAST(seq AS TEXT) AS id FROM sqlite_sequence WHERE name='archive_pieces'").get() as { id: string } | undefined;
      const floor = retained.id === null ? BigInt(sequence?.id ?? '0') + 1n : BigInt(retained.id);
      if (floor <= 0n || floor > RAW_PIECE_NAMESPACE) throw new Error('Invalid ClickHouse replay floor');
      return { version: 1, sourceId: source.sourceId, firstReplayablePieceSeq: floor.toString() };
    })();
  } finally { db.close(); }
}

export async function runReplayFloorMode(): Promise<void> {
  const file = app.commandLine.getSwitchValue(REPLAY_FLOOR_SWITCH);
  if (!isAbsolute(file) || hasTransferSwitch()) {
    console.error('Use --clickhouse-replay-floor=<absolute new file> on its own.');
    app.exit(TRANSFER_EXIT.invalidArguments);
    return;
  }
  if (!app.requestSingleInstanceLock()) {
    console.error('Quit Spillway before reporting a ClickHouse replay floor.');
    app.exit(TRANSFER_EXIT.appRunning);
    return;
  }
  try {
    await app.whenReady();
    const directory = await activityStorage().snapshotDirectory();
    const report = await snapshotReplayFloor(join(directory, ACTIVITY_FILES.database), await readExistingDatabaseKey());
    await writeFile(file, JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
    app.exit(TRANSFER_EXIT.ok);
  } catch {
    console.error('Could not write the ClickHouse replay floor. Check the archive, finish any storage move, and choose a new report file.');
    app.exit(TRANSFER_EXIT.failed);
  }
}
