import { parentPort, workerData } from 'node:worker_threads';
import { openKeyed } from './activityDb';
import { repriceActivity } from './activityReprice';
const { activityDb, databaseKey } = workerData as { activityDb: string; databaseKey: string };
const db = openKeyed(activityDb, databaseKey);
try { parentPort!.postMessage(repriceActivity(db)); }
finally { db.close(); }
