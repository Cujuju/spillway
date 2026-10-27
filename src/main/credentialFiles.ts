import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import type { CredentialImportResult } from '@shared/types';
import { management } from './managementClient';
import { mainWindow } from './window';

/** Login files are a few KB; anything far larger is not one, so it is refused before reading. */
const MAX_LOGIN_FILE_BYTES = 1024 * 1024;
/** Owner read/write only: the file holds the account's tokens. Ignored on Windows. */
const PRIVATE_FILE_MODE = 0o600;
const JSON_FILTER = [{ name: 'Login file', extensions: ['json'] }];

const openDialog = (opts: OpenDialogOptions) => {
  const w = mainWindow();
  return w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts);
};
const saveDialog = (opts: SaveDialogOptions) => {
  const w = mainWindow();
  return w ? dialog.showSaveDialog(w, opts) : dialog.showSaveDialog(opts);
};

/**
 * Asks for login files and uploads each under its file name; null when cancelled.
 * `existing` names the accounts already saved, so overwrites are reported.
 */
export async function importLoginFiles(existing: ReadonlySet<string>): Promise<CredentialImportResult | null> {
  const picked = await openDialog({ title: 'Import login files', properties: ['openFile', 'multiSelections'], filters: JSON_FILTER });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  const result: CredentialImportResult = { imported: [], replaced: [], failed: [] };
  for (const file of picked.filePaths) {
    const name = path.basename(file);
    try {
      if ((await stat(file)).size > MAX_LOGIN_FILE_BYTES) throw new Error('Too large to be a login file');
      await management.uploadCredential(name, await readFile(file, 'utf8'));
      (existing.has(name) ? result.replaced : result.imported).push(name);
    } catch (err) {
      result.failed.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Asks where to save the account's login file and writes the proxy's copy there; the saved path, or null when cancelled. */
export async function exportLoginFile(name: string): Promise<string | null> {
  const target = await saveDialog({
    title: 'Export login file',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: JSON_FILTER,
  });
  if (target.canceled || !target.filePath) return null;
  await writeFile(target.filePath, await management.downloadCredential(name), { mode: PRIVATE_FILE_MODE });
  return target.filePath;
}
