import { parentPort, workerData } from 'node:worker_threads';
import { ActivityLog } from './activityStore';
import { conversationNames } from './conversationNames';
import { startClientLogSync } from './clientLogSync';
import type { ActivityMethods, Request, WorkerConfig } from './activityProtocol';
const port = parentPort!;
const log = new ActivityLog(workerData as WorkerConfig);
log.prune();
const startSync = () => startClientLogSync(log, () => {
  log.prune();
  port.postMessage({ event: 'reset' });
}, (value) => port.postMessage({ event: 'progress', value }));
let stop = startSync();
const methods: Omit<ActivityMethods, 'clear'> & { clear(): Promise<void> } = {
  append: (e) => {
    const revision = log.revision;
    const stored = log.append(e);
    if (revision !== log.revision) port.postMessage({ event: 'reset' });
    return stored;
  },
  page: (q) => log.page(q), day: (...args) => log.day(...args), days: () => log.days(),
  daySummaries: (scope) => log.daySummaries(scope), totalsList: () => log.totalsList(),
  buckets: (days) => log.buckets(days), coverage: () => log.coverage(),
  clear: async () => { await stop(); log.clear(); stop = startSync(); }, prune: () => log.prune(), setRetention: (days) => log.setRetention(days),
  names: (ids) => conversationNames.names(ids),
  close: async () => { await stop(); log.close(); },
};
let queue = Promise.resolve();
port.on('message', (request: Request) => {
  queue = queue.then(async () => {
    try {
      const fn = methods[request.method] as (...args: unknown[]) => unknown;
      const value = await fn(...request.args);
      port.postMessage({ id: request.id, value });
      if (request.method === 'close') port.close();
    } catch (e) { port.postMessage({ id: request.id, error: e instanceof Error ? e.message : String(e) }); }
  });
});
