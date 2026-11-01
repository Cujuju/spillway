import { app } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { APP_NAME } from '@shared/app';
import type { ActivityEvent } from '@shared/types';
import { ActivityLog } from './activityStore';
import { history } from './historyStore';
import { mergeHistory, type TransferHistory } from './historyMerge';
import { appPaths } from './paths';
import { getSecrets, getSettings, loadSecrets, writeFileAtomic } from './settingsStore';

export const TRANSFER_EXIT = { ok: 0, failed: 1, appRunning: 20, invalidArguments: 21 } as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const IMPORT_BATCH_SIZE = 1000;
const VERSION = 1;
interface TransferHeader { version: number; app: string; history: TransferHistory }

export const hasTransferSwitch = (): boolean => app.commandLine.hasSwitch('data-export') || app.commandLine.hasSwitch('data-import');
export function transferKey(value: string | undefined): Buffer {
  if (!value || !/^[\da-f]{64}$/i.test(value)) throw new Error('SPILLWAY_TRANSFER_KEY must contain exactly 64 hex characters');
  return Buffer.from(value, 'hex');
}

export async function exportData(file: string, key: Buffer, log: ActivityLog, records: TransferHistory): Promise<number> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const output = await open(file, 'wx', 0o600);
  let count = 0;
  try {
    await output.writeFile(iv);
    const header: TransferHeader = { version: VERSION, app: APP_NAME, history: records };
    await output.writeFile(cipher.update(`${JSON.stringify(header)}\n`));
    for (const event of log.exportEvents()) {
      await output.writeFile(cipher.update(`${JSON.stringify(event)}\n`));
      count++;
    }
    await output.writeFile(cipher.final());
    await output.writeFile(cipher.getAuthTag());
  } finally { await output.close(); }
  return count;
}

export function decryptData(file: string, key: Buffer): { header: TransferHeader; lines: string[] } {
  const data = readFileSync(file);
  if (data.length < IV_BYTES + TAG_BYTES) throw new Error('Truncated transfer file');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES));
  decipher.setAuthTag(data.subarray(-TAG_BYTES));
  const plaintext = Buffer.concat([decipher.update(data.subarray(IV_BYTES, -TAG_BYTES)), decipher.final()]);
  const lines = plaintext.toString('utf8').trimEnd().split('\n');
  const header = JSON.parse(lines.shift()!) as TransferHeader;
  if (header.version !== VERSION || typeof header.app !== 'string' || !Array.isArray(header.history?.samples)
    || !Array.isArray(header.history?.summaries) || !Array.isArray(header.history?.observed)) throw new Error('Invalid transfer header');
  return { header, lines };
}

export function importData(file: string, key: Buffer, log: ActivityLog, beforeWrite: (records: TransferHistory) => void): number {
  const { header, lines } = decryptData(file, key);
  beforeWrite(header.history);
  for (let start = 0; start < lines.length; start += IMPORT_BATCH_SIZE) {
    log.importEvents(lines.slice(start, start + IMPORT_BATCH_SIZE).map((line) => JSON.parse(line) as ActivityEvent));
  }
  return lines.length;
}

function backupData(): string[] {
  const suffix = `.pre-merge-${Date.now()}`;
  const files = [appPaths.activityDb, `${appPaths.activityDb}-wal`, `${appPaths.activityDb}-shm`,
    appPaths.historyFile, appPaths.windowSummariesFile, appPaths.observedSpansFile];
  return files.filter(existsSync).map((file) => {
    const backup = `${file}${suffix}`;
    copyFileSync(file, backup, constants.COPYFILE_EXCL);
    return backup;
  });
}
const readHistory = (): TransferHistory => ({ samples: history.all(), summaries: history.summaries(), observed: history.observed() });

export async function runTransferMode(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    console.error(`${APP_NAME} is running`);
    app.exit(TRANSFER_EXIT.appRunning);
    return;
  }
  let log: ActivityLog | undefined;
  let code: number = TRANSFER_EXIT.failed;
  try {
    const exporting = app.commandLine.hasSwitch('data-export');
    const importing = app.commandLine.hasSwitch('data-import');
    const file = app.commandLine.getSwitchValue(exporting ? 'data-export' : 'data-import');
    let key: Buffer;
    try {
      if (exporting === importing || !file) throw new Error('Supply exactly one of --data-export=<file> or --data-import=<file>');
      key = transferKey(process.env.SPILLWAY_TRANSFER_KEY);
    } catch (err) {
      console.error(String(err));
      app.exit(TRANSFER_EXIT.invalidArguments);
      return;
    }
    await app.whenReady();
    await loadSecrets();
    log = new ActivityLog({ activityDb: appPaths.activityDb, legacyActivityDir: appPaths.legacyActivityDir,
      databaseKey: getSecrets().databaseKey, retentionDays: getSettings().activity.retentionDays });
    if (exporting) {
      const count = await exportData(file, key, log, readHistory());
      console.log(`${APP_NAME}: exported ${count} activity events from ${appPaths.root}`);
    } else {
      let merged: TransferHistory | undefined;
      const count = importData(file, key, log, (incoming) => {
        for (const backup of backupData()) console.log(`Backup: ${backup}`);
        merged = mergeHistory(readHistory(), incoming);
      });
      writeFileAtomic(appPaths.historyFile, JSON.stringify(merged!.samples));
      writeFileAtomic(appPaths.windowSummariesFile, JSON.stringify(merged!.summaries));
      writeFileAtomic(appPaths.observedSpansFile, JSON.stringify(merged!.observed));
      console.log(`${APP_NAME}: replayed ${count} activity events; merged ${merged!.samples.length} samples, ${merged!.summaries.length} summaries, ${merged!.observed.length} spans into ${appPaths.root}`);
    }
    code = TRANSFER_EXIT.ok;
  } catch (err) { console.error(`${APP_NAME} data transfer: ${String(err)}`); }
  finally { log?.close(); }
  app.exit(code);
}
