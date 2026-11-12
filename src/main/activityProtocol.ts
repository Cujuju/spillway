import type { ActivityLog, ActivityConfig } from './activityStore';
import type { conversationNames } from './conversationNames';
import type { ActivityImportState, ArchiveMigrationState } from '@shared/ipc';
export type ActivityMethods = Pick<ActivityLog, 'thinkingTestPrepare' | 'thinkingTestSave' | 'thinkingTests' | 'priceSnapshot' | 'pricesChanged' | 'canaryLastRunAt' | 'driftQuery' | 'canarySave' | 'canaryResults' | 'append' | 'page' | 'day' | 'days' | 'daySummaries' | 'totalsList' | 'thinking' | 'compare' | 'buckets' | 'bucketSnapshot' | 'coverage' | 'clear' | 'prune' | 'setRetention' | 'archiveObserve' | 'archiveIngest' | 'archiveDetail' | 'archiveStatus' | 'archivePolicy' | 'archiveClear' | 'archiveExportPrepare' | 'archiveExportStatus' | 'archiveExportStart' | 'archiveExportCancel' | 'clickhouseStatus' | 'clickhouseConfigure' | 'clickhousePrepare' | 'clickhouseAcknowledge' | 'clickhouseFail' | 'clickhouseRetry' | 'clickhouseClear' | 'diagnosticSnapshot' | 'traceQuery' | 'traceAttempts'> & {
  names: typeof conversationNames.names;
  close(): Promise<void>;
};
export type EvalMethods = Pick<ActivityLog, 'evalList' | 'evalGet' | 'evalCreate' | 'evalRevise' | 'evalDelete' | 'evalExport' | 'evalImport'>;
export type Method = keyof (ActivityMethods & EvalMethods);
export type Request = { [K in Method]: { id: number; method: K; args: Parameters<(ActivityMethods & EvalMethods)[K]> } }[Method];
export type Reply = { id: number; value?: unknown; error?: string };
export type WorkerMessage = Reply | { event: 'progress'; value: ActivityImportState } | { event: 'migration'; value: ArchiveMigrationState } | { event: 'reset' };
export type WorkerConfig = ActivityConfig;
