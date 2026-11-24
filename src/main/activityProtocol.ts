import type { ActivityLog, ActivityConfig } from './activityStore';
import type { conversationNames } from './conversationNames';
import type { ActivityImportState, ArchiveMigrationState } from '@shared/ipc';
export type ActivityMethods = Pick<ActivityLog, 'thinkingTestPrepare' | 'thinkingTestSave' | 'thinkingTests' | 'priceSnapshot' | 'pricesChanged' | 'canaryLastRunAt' | 'driftQuery' | 'canarySave' | 'canaryResults' | 'append' | 'page' | 'day' | 'days' | 'daySummaries' | 'totalsList' | 'thinking' | 'compare' | 'waste' | 'buckets' | 'bucketSnapshot' | 'coverage' | 'clear' | 'prune' | 'setRetention' | 'setAccountMap' | 'archiveObserve' | 'archiveIngestBatch' | 'archiveDetail' | 'archiveStatus' | 'archivePolicy' | 'archiveClear' | 'archiveClearAcknowledged' | 'archiveExportPrepare' | 'archiveExportStatus' | 'archiveExportStart' | 'archiveExportCancel' | 'clickhouseStatus' | 'clickhouseConfigure' | 'clickhousePrepare' | 'clickhouseAcknowledge' | 'clickhouseFail' | 'clickhouseRetry' | 'clickhouseClear' | 'clickhouseMirrorUsage' | 'diagnosticSnapshot' | 'traceQuery' | 'traceAttempts'> & {
  names: typeof conversationNames.names;
  activityOlderBoundaries: ActivityLog['activityOlderBoundaries'];
  close(): Promise<void>;
};
export type EvalMethods = Pick<ActivityLog, 'evalList' | 'evalGet' | 'evalCreate' | 'evalRevise' | 'evalDelete' | 'evalExport' | 'evalImport'>;
export type Method = keyof (ActivityMethods & EvalMethods);
/** Pure SELECT-only SQLite methods safe to run concurrently in the WAL reader worker. */
export const READ_ONLY_ACTIVITY_METHODS: ReadonlySet<Method> = new Set<Method>([
  'page', 'day', 'days', 'daySummaries', 'totalsList', 'buckets', 'bucketSnapshot',
  'compare', 'waste', 'driftQuery', 'coverage', 'thinkingTests',
]);
export type Request = { [K in Method]: { id: number; method: K; args: Parameters<(ActivityMethods & EvalMethods)[K]> } }[Method];
export type Reply = { id: number; value?: unknown; error?: string };
export type WorkerMessage = Reply | { event: 'progress'; value: ActivityImportState } | { event: 'migration'; value: ArchiveMigrationState } | { event: 'reset' };
export type WorkerConfig = ActivityConfig;
