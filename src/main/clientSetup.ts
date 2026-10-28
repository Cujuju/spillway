/** Applies and undoes the proxy settings in each client's own config file, with a backup beside it. */
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientId, ClientSetupState, ClientSetupStatus } from '@shared/types';
import {
  applyClaude, applyCodex, claudeIsEmpty, claudeState, codexIsEmpty, codexState, undoClaude, undoCodex, type ClientTarget,
} from './clientConfigText';
import { CODEX_AUTH_FILE, isCodexPoolAuth } from './codexPoolAuth';
import { writeFileAtomic } from './settingsStore';

export const BACKUP_SUFFIX = '.spillway-backup';

interface ClientEdit {
  apply(text: string | null, target: ClientTarget): string;
  undo(text: string, backup: string | null): string;
  state(text: string | null, target: ClientTarget, hasBackup: boolean): ClientSetupState;
  isEmpty(text: string): boolean;
  /** Undo needs the backup's content, not only the markers. */
  undoNeedsBackup: boolean;
}

const EDITS: Record<ClientId, ClientEdit> = {
  claude: { apply: applyClaude, undo: undoClaude, state: claudeState, isEmpty: claudeIsEmpty, undoNeedsBackup: true },
  codex: { apply: applyCodex, undo: undoCodex, state: codexState, isEmpty: codexIsEmpty, undoNeedsBackup: false },
};

export const CLIENT_IDS = Object.keys(EDITS) as ClientId[];

/** Home folder per client, honouring the overrides each client reads (CLAUDE_CONFIG_DIR, CODEX_HOME). */
export function clientHomes(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Record<ClientId, string> {
  return { claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), codex: env.CODEX_HOME || path.join(home, '.codex') };
}

/** Config file per client. */
export function clientConfigFiles(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Record<ClientId, string> {
  const homes = clientHomes(env, home);
  return { claude: path.join(homes.claude, 'settings.json'), codex: path.join(homes.codex, 'config.toml') };
}

const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);
/** Writes through a symlinked dotfile instead of replacing the link. */
const resolved = (file: string) => (existsSync(file) ? realpathSync(file) : file);
const display = (file: string, home: string) => (file.startsWith(home) ? `~${file.slice(home.length)}` : file);

/**
 * Retires the pool login earlier versions wrote to auth.json: restores the user's backed-up login,
 * or removes it so Codex asks to sign in. A newer login is kept.
 */
function retireCodexPoolLogin(configFile: string): void {
  const authFile = path.join(path.dirname(configFile), CODEX_AUTH_FILE);
  const backupFile = `${authFile}${BACKUP_SUFFIX}`;
  const text = read(authFile);
  if (text !== null && isCodexPoolAuth(text)) {
    const backup = read(backupFile);
    if (backup) writeFileAtomic(resolved(authFile), backup);
    else rmSync(resolved(authFile));
  }
  rmSync(backupFile, { force: true });
}

export function clientStatus(client: ClientId, file: string, target: ClientTarget, home = os.homedir()): ClientSetupStatus {
  const base = { client, path: display(file, home) };
  try {
    const state = EDITS[client].state(read(file), target, existsSync(`${file}${BACKUP_SUFFIX}`));
    return { ...base, state, error: null };
  } catch (err) {
    return { ...base, state: 'not-applied', error: (err as Error).message };
  }
}

/** Backs the file up before the first apply. A missing file is backed up as an empty one. */
export function applyClient(client: ClientId, file: string, target: ClientTarget): void {
  const text = read(file);
  // Computed first: a file the edit rejects is left untouched, backup included.
  const next = EDITS[client].apply(text, target);
  const backup = `${file}${BACKUP_SUFFIX}`;
  if (!existsSync(backup)) {
    if (text === null) writeFileAtomic(backup, '');
    else copyFileSync(resolved(file), backup);
  }
  writeFileAtomic(resolved(file), next);
  if (client === 'codex') retireCodexPoolLogin(file);
}

/** Reverses the apply and removes the backup. A file the apply created is deleted when nothing else was added. */
export function undoClient(client: ClientId, file: string): void {
  const backupFile = `${file}${BACKUP_SUFFIX}`;
  const backup = read(backupFile);
  if (backup === null && EDITS[client].undoNeedsBackup) throw new Error(`No backup at ${backupFile}; nothing to undo`);
  const text = read(file);
  if (text !== null) {
    const next = EDITS[client].undo(text, backup);
    if (backup === '' && EDITS[client].isEmpty(next)) rmSync(resolved(file));
    else writeFileAtomic(resolved(file), next);
  }
  rmSync(backupFile, { force: true });
  if (client === 'codex') retireCodexPoolLogin(file);
}
