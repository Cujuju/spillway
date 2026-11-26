import { parentPort, workerData } from 'node:worker_threads';
import { ActivityLog } from './activityStore';
import { installCatalogPrices, type CatalogPrices } from '@shared/modelPrices';
import type { Request, WorkerConfig } from './activityProtocol';

const port = parentPort!;
installCatalogPrices((workerData as WorkerConfig).catalogPrices);
const log = new ActivityLog({ ...(workerData as WorkerConfig), readonly: true });

const methods = {
  setPrices: (prices: CatalogPrices) => log.setPrices(prices),
  page: (q: Parameters<ActivityLog['page']>[0]) => log.page(q),
  day: (...args: Parameters<ActivityLog['day']>) => log.day(...args),
  days: () => log.days(),
  daySummaries: (scope: Parameters<ActivityLog['daySummaries']>[0]) => log.daySummaries(scope),
  totalsList: () => log.totalsList(),
  buckets: (days: Parameters<ActivityLog['buckets']>[0]) => log.buckets(days),
  bucketSnapshot: (...args: Parameters<ActivityLog['bucketSnapshot']>) => log.bucketSnapshot(...args),
  compare: (...args: Parameters<ActivityLog['compare']>) => log.compare(...args),
  waste: (q: Parameters<ActivityLog['waste']>[0]) => log.waste(q),
  driftQuery: (q: Parameters<ActivityLog['driftQuery']>[0]) => log.driftQuery(q),
  coverage: () => log.coverage(),
  thinkingTests: () => log.thinkingTests(),
  traceQuery: (q: Parameters<ActivityLog['traceQuery']>[0]) => log.traceQuery(q),
  traceAttempts: (q: Parameters<ActivityLog['traceAttempts']>[0]) => log.traceAttempts(q),
  close: () => { log.close(); },
};

let queue = Promise.resolve();
port.on('message', (request: Request) => {
  queue = queue.then(async () => {
    try {
      const fn = methods[request.method as keyof typeof methods] as ((...args: unknown[]) => unknown) | undefined;
      if (!fn) throw new Error(`Unsupported read worker method: ${request.method}`);
      const value = await fn(...request.args);
      port.postMessage({ id: request.id, value });
      if (request.method === 'close') port.close();
    } catch (e) {
      port.postMessage({ id: request.id, error: e instanceof Error ? e.message : String(e) });
    }
  });
});
