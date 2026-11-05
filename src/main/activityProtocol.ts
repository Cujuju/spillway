import type { ActivityLog, ActivityConfig } from './activityStore';
import type { conversationNames } from './conversationNames';
import type { ActivityImportState } from '@shared/ipc';
export type ActivityMethods = Pick<ActivityLog, 'append' | 'page' | 'day' | 'days' | 'daySummaries' | 'totalsList' | 'buckets' | 'bucketSnapshot' | 'coverage' | 'clear' | 'prune' | 'setRetention' | 'archiveObserve' | 'archiveIngest' | 'archiveQuery' | 'archiveDetail' | 'archiveStatus' | 'archivePolicy' | 'archiveClear' | 'archiveExportPrepare' | 'archiveExportStatus' | 'archiveExportStart' | 'archiveExportCancel' | 'clickhouseStatus' | 'clickhouseConfigure' | 'clickhousePrepare' | 'clickhouseAcknowledge' | 'clickhouseFail' | 'clickhouseRetry' | 'clickhouseClear' | 'diagnosticSnapshot'> & {
  names: typeof conversationNames.names;
  close(): Promise<void>;
};
export type Method = keyof ActivityMethods;
export type Request = { [K in Method]: { id: number; method: K; args: Parameters<ActivityMethods[K]> } }[Method];
export type Reply = { id: number; value?: unknown; error?: string };
export type WorkerMessage = Reply | { event: 'progress'; value: ActivityImportState } | { event: 'reset' };
export type WorkerConfig = ActivityConfig;
