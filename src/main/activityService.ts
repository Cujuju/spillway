import repriceWorkerPath from './activityRepriceWorker?modulePath';
import { ActivityRepriceJob } from './activityRepriceJob';
import { Worker } from 'node:worker_threads';
import workerPath from './activityWorker?modulePath';
import readWorkerPath from './activityReadWorker?modulePath';
import namesWorkerPath from './conversationNamesWorker?modulePath';
import { ActivityRpc } from './activityRpc';
import { ActivityRouter } from './activityRouter';
import { activityStorage, appPaths } from './paths';
import { getSecrets, getSettings } from './settingsStore';
import type { ActivityImportState, ArchiveMigrationState } from '@shared/ipc';
import type { CatalogPrices } from '@shared/modelPrices';
import { net } from 'electron';
import { PriceCatalog } from './priceCatalog';
import { writeFileAtomic } from './settingsStore';
import type { WorkerConfig } from './activityProtocol';

export const priceCatalog = new PriceCatalog({ file: appPaths.priceCatalogFile, fetch: (url, init) => net.fetch(url, init), write: writeFileAtomic });

const workerConfig = (): WorkerConfig => {
  activityStorage().verifyActive();
  return {
    activityDb: appPaths.activityDb, legacyActivityDir: appPaths.legacyActivityDir,
    databaseKey: getSecrets().databaseKey, retentionDays: getSettings().activity.retentionDays,
    catalogPrices: priceCatalog.prices(),
  };
};

const writerRpc = new ActivityRpc(() => new Worker(workerPath, { workerData: workerConfig() }));
const makeReaderRpc = () => new ActivityRpc(() => new Worker(readWorkerPath, { workerData: workerConfig() }));
const namesRpc = new ActivityRpc(() => new Worker(namesWorkerPath));

export const activityLog = new ActivityRouter(writerRpc, makeReaderRpc, namesRpc);

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

const repricing = new ActivityRepriceJob(() => {
  activityStorage().verifyActive();
  return new Worker(repriceWorkerPath, { workerData: {
    activityDb: appPaths.activityDb, databaseKey: getSecrets().databaseKey, catalogPrices: priceCatalog.prices(),
  } });
}, () => activityLog.call('pricesChanged'));
let checkedPrices = false;
activityLog.on('reset', () => {
  if (checkedPrices) return;
  checkedPrices = true;
  void activityLog.call('priceSnapshot').then((previous) => repricing.start(previous))
    .catch((error) => console.error('[activity] price snapshot failed:', error));
});
export const stopActivityReprice = () => repricing.stop();

/** New catalog prices reach both activity workers first, so requests stored after this price with them; then history reprices. */
export async function applyCatalogPrices(prices: CatalogPrices): Promise<void> {
  await activityLog.setPrices(prices);
  repricing.start(await activityLog.call('priceSnapshot'));
}
