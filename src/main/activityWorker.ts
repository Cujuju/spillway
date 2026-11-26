import { parentPort, workerData } from 'node:worker_threads';
import { ActivityLog } from './activityStore';
import { installCatalogPrices } from '@shared/modelPrices';
import { startClientLogSync } from './clientLogSync';
import { startTitleExport } from './titleExport';
import type { ActivityMethods, EvalMethods, Request, WorkerConfig } from './activityProtocol';
const port = parentPort!;
installCatalogPrices((workerData as WorkerConfig).catalogPrices);
const log = new ActivityLog(workerData as WorkerConfig, (value) => port.postMessage({ event: 'migration', value }));
const reset = () => port.postMessage({ event: 'reset' });
log.prune();
try { log.archiveExportReset(); }
catch (error) { log.archiveExportStartupError(`Portable export startup cleanup failed: ${String(error)}`); }
reset();
const startSync = () => startClientLogSync(log, reset,
  (value) => port.postMessage({ event: 'progress', value }));
let stop = startSync();
const titles = startTitleExport(log);
const ARCHIVE_PRUNE_INTERVAL_MS = 60 * 60_000;
const archiveMaintenance = setInterval(() => {
  try { log.archivePrune(); }
  catch (error) { console.error('[archive] maintenance failed:', error); }
}, ARCHIVE_PRUNE_INTERVAL_MS).unref();
const methods: Omit<ActivityMethods, 'clear' | 'names'> & EvalMethods & { clear(): Promise<void> } = {
  thinkingTestPrepare: (req) => log.thinkingTestPrepare(req), thinkingTestSave: (test) => log.thinkingTestSave(test), thinkingTests: () => log.thinkingTests(),
  priceSnapshot: () => log.priceSnapshot(),
  pricesChanged: () => { log.pricesChanged(); reset(); },
  setPrices: (prices) => log.setPrices(prices),
  canaryLastRunAt: () => log.canaryLastRunAt(),
  driftQuery: (q) => log.driftQuery(q), canarySave: (r) => log.canarySave(r), canaryResults: (q) => log.canaryResults(q),
  evalList: () => log.evalList(), evalGet: (id, revision) => log.evalGet(id, revision),
  evalCreate: (...args) => log.evalCreate(...args), evalRevise: (...args) => log.evalRevise(...args),
  evalDelete: (id) => log.evalDelete(id), evalExport: (...args) => log.evalExport(...args), evalImport: (file) => log.evalImport(file),
  append: (e) => {
    const revision = log.revision;
    const stored = log.append(e);
    try { log.archiveObserve(e); }
    finally {
      if (revision !== log.revision) reset();
      else if (stored && log.lastAppendBuckets.length) port.postMessage({ event: 'buckets', value: { watermark: log.lastAppendWatermark, buckets: log.lastAppendBuckets } });
    }
    return stored;
  },
  page: (q) => log.page(q), day: (...args) => log.day(...args), days: () => log.days(),
  daySummaries: (scope) => log.daySummaries(scope), totalsList: () => log.totalsList(), thinking: (q, models) => log.thinking(q, models), compare: (q, quota) => log.compare(q, quota), waste: (q) => log.waste(q),
  buckets: (days) => log.buckets(days), bucketSnapshot: (...args) => log.bucketSnapshot(...args), coverage: () => log.coverage(),
  activityOlderBoundaries: () => log.activityOlderBoundaries(),
  clear: async () => { await stop(); log.clear(); reset(); stop = startSync(); },
  prune: () => { const revision = log.revision; log.prune(); if (revision !== log.revision) reset(); },
  setRetention: (days) => { const revision = log.revision; log.setRetention(days); if (revision !== log.revision) reset(); },
  setAccountMap: async (accounts) => {
    const changed = await log.setAccountMap(accounts);
    if (changed) reset();
    return changed;
  },
  archiveObserve: (e) => log.archiveObserve(e), archiveIngestBatch: (ps) => log.archiveIngestBatch(ps),
  archiveDetail: (id) => log.archiveDetail(id),
  archiveStatus: () => log.archiveStatus(), archivePolicy: (p) => log.archivePolicy(p), archiveClear: () => log.archiveClear(), archiveClearAcknowledged: () => log.archiveClearAcknowledged(),
  archiveExportPrepare: (o) => log.archiveExportPrepare(o), archiveExportStatus: (id) => log.archiveExportStatus(id),
  archiveExportStart: (id, file) => log.archiveExportStart(id, file), archiveExportCancel: (id) => log.archiveExportCancel(id),
  clickhouseStatus: () => log.clickhouseStatus(), clickhouseConfigure: (c) => { log.clickhouseConfigure(c); titles.refresh(); },
  clickhousePrepare: () => log.clickhousePrepare(), clickhouseAcknowledge: (t, d) => log.clickhouseAcknowledge(t, d),
  clickhouseFail: (t, n, e) => log.clickhouseFail(t, n, e), clickhouseRetry: () => log.clickhouseRetry(), clickhouseClear: () => log.clickhouseClear(), clickhouseMirrorUsage: (r, o) => log.clickhouseMirrorUsage(r, o),
  diagnosticSnapshot: (id, bodies) => log.diagnosticSnapshot(id, bodies),
  traceQuery: (q) => log.traceQuery(q), traceAttempts: (q) => log.traceAttempts(q),
  close: async () => { clearInterval(archiveMaintenance); await titles.stop(); await stop(); await log.archiveExportDispose(); log.close(); },
};
let queue = Promise.resolve();
port.on('message', (request: Request) => {
  queue = queue.then(async () => {
    try {
      const fn = methods[request.method as keyof typeof methods] as ((...args: unknown[]) => unknown) | undefined;
      if (!fn) throw new Error(`Unsupported worker method: ${request.method}`);
      const value = await fn(...request.args);
      port.postMessage({ id: request.id, value });
      if (request.method === 'close') port.close();
    } catch (e) { port.postMessage({ id: request.id, error: e instanceof Error ? e.message : String(e) }); }
  });
});
