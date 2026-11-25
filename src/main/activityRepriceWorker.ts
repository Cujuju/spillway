import { parentPort, workerData } from 'node:worker_threads';
import { installCatalogPrices, type CatalogPrices } from '@shared/modelPrices';
import { openKeyed } from './activityDb';
import { repriceActivity } from './activityReprice';
const { activityDb, databaseKey, catalogPrices } = workerData as { activityDb: string; databaseKey: string; catalogPrices: CatalogPrices };
installCatalogPrices(catalogPrices);
const db = openKeyed(activityDb, databaseKey);
try { parentPort!.postMessage(repriceActivity(db)); }
finally { db.close(); }
