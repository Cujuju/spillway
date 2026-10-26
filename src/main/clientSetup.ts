/** Applies and undoes the proxy settings in each client's own config file, with a backup beside it. */
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientId, ClientSetupState, ClientSetupStatus } from '@shared/types';
import {
  applyClaude, applyCodex, claudeIsEmpty, claudeState, codexIsEmpty, codexState, undoClaude, undoCodex, type ClientTarget,
} from './clientConfigText';
import { CODEX_AUTH_FILE, codexPoolAuthJson, codexPoolAuthMatches, isCodexPoolAuth } from './codexPoolAuth';
import { writeFileAtomic } from './settingsStore';

export const BACKUP_SUFFIX = '.spillway-backup';

/** A file beside the config file that apply replaces whole; undo restores the user's own copy. */
interface Companion {
  name: string;
  content(target: ClientTarget): string;
  /** True when the file holds what apply writes, for any key. */
  isOurs(text: string): boolean;
  /** True when the file is applied for this target; parts kept in step automatically (the account) don't count. */
  matches(text: string, target: ClientTarget): boolean;
}

const COMPANIONS: Partial<Record<ClientId, Companion>> = {
  // Codex's login: the pool login sends its account calls through the proxy as the routed account.
  codex: {
    name: CODEX_AUTH_FILE,
    content: (t) => codexPoolAuthJson(t.key, t.codexAccountEmail),
    isOurs: isCodexPoolAuth,
    matches: (text, t) => codexPoolAuthMatches(text, t.key),
  },
};

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

/** Config file per client, honouring the overrides each client reads (CLAUDE_CONFIG_DIR, CODEX_HOME). */
export function clientConfigFiles(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Record<ClientId, string> {
  return {
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
    codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
  };
}

const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);
/** Writes through a symlinked dotfile instead of replacing the link. */
const resolved = (file: string) => (existsSync(file) ? realpathSync(file) : file);
const display = (file: string, home: string) => (file.startsWith(home) ? `~${file.slice(home.length)}` : file);
const companionPath = (file: string, companion: Companion) => path.join(path.dirname(file), companion.name);

/** Out of date while the config file is applied but its companion holds something else. */
function stateWithCompanion(client: ClientId, file: string, target: ClientTarget, state: ClientSetupState): ClientSetupState {
  const companion = COMPANIONS[client];
  if (!companion || state !== 'applied') return state;
  const text = read(companionPath(file, companion));
  return text !== null && companion.matches(text, target) ? state : 'out-of-date';
}

/** Rewrites an applied companion whose content went stale (the routed account changed). A file the user replaced is left alone. */
export function syncCompanion(client: ClientId, file: string, target: ClientTarget): void {
  const companion = COMPANIONS[client];
  if (!companion) return;
  const companionFile = companionPath(file, companion);
  const text = read(companionFile);
  if (text === null || !companion.matches(text, target)) return;
  const content = companion.content(target);
  if (text !== content) writeFileAtomic(resolved(companionFile), content);
}

/** Backs up the user's own file (a newer one, e.g. a fresh login, replaces an older backup), then replaces it. */
function applyCompanion(companion: Companion, file: string, target: ClientTarget): void {
  const companionFile = companionPath(file, companion);
  const text = read(companionFile);
  const content = companion.content(target);
  if (text === content) return;
  if (text === null) writeFileAtomic(`${companionFile}${BACKUP_SUFFIX}`, '');
  else if (!companion.isOurs(text)) copyFileSync(resolved(companionFile), `${companionFile}${BACKUP_SUFFIX}`);
  writeFileAtomic(resolved(companionFile), content);
}

/** Restores the backup only over the app's own content; a file the user replaced since is kept. */
function undoCompanion(companion: Companion, file: string): void {
  const companionFile = companionPath(file, companion);
  const backupFile = `${companionFile}${BACKUP_SUFFIX}`;
  const text = read(companionFile);
  if (text !== null && companion.isOurs(text)) {
    const backup = read(backupFile);
    if (backup) writeFileAtomic(resolved(companionFile), backup);
    else rmSync(resolved(companionFile));
  }
  rmSync(backupFile, { force: true });
}

export function clientStatus(client: ClientId, file: string, target: ClientTarget, home = os.homedir()): ClientSetupStatus {
  const base = { client, path: display(file, home) };
  try {
    const state = EDITS[client].state(read(file), target, existsSync(`${file}${BACKUP_SUFFIX}`));
    return { ...base, state: stateWithCompanion(client, file, target, state), error: null };
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
  const companion = COMPANIONS[client];
  if (companion) applyCompanion(companion, file, target);
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
  const companion = COMPANIONS[client];
  if (companion) undoCompanion(companion, file);
}
