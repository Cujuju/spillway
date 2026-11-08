import { Worker } from 'node:worker_threads';
import workerPath from './activityWorker?modulePath';
import { ActivityRpc } from './activityRpc';
import { appPaths } from './paths';
import { getSecrets, getSettings } from './settingsStore';
import type { ActivityImportState, ArchiveMigrationState } from '@shared/ipc';
export const activityLog = new ActivityRpc(() => new Worker(workerPath, { workerData: {
  activityDb: appPaths.activityDb, legacyActivityDir: appPaths.legacyActivityDir,
  databaseKey: getSecrets().databaseKey, retentionDays: getSettings().activity.retentionDays,
} }));
let progress: ActivityImportState = { state: 'idle', filesDone: 0, filesTotal: 0, recordsImported: 0, error: null };
let migration: ArchiveMigrationState = { state: 'idle', done: 0, total: 0 };
activityLog.on('migration', (state: ArchiveMigrationState) => { migration = state; });
activityLog.on('progress', (state: ActivityImportState) => { progress = state; });
activityLog.on('failure', (error: string) => {
  progress = { ...progress, state: 'idle', error };
  migration = { state: 'idle', done: 0, total: 0 };
  activityLog.emit('migration', migration);
  console.error('[activity]', error);
  activityLog.emit('progress', progress);
});
export const activityImportState = () => progress;
export const archiveMigrationState = () => migration;
