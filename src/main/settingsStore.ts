import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import { appPaths } from './paths';
import { validateClickHouseCredentials, type ClickHouseCredentials } from '@shared/clickhouse';

/** Stored using the platform's existing secrets mechanism; destination credentials stay in the main process. */
interface Secrets {
  /** Key clients such as Claude Code send to the proxy. */
  clientApiKey: string;
  /** Management key for outside tools (T3 Code's usage provider); the app itself uses the per-launch supervisor password. */
  managementKey: string;
  /** Hex key of the encrypted activity database (activityDb.ts). Losing it sets that database aside. */
  databaseKey: string;
  clickhouse?: ClickHouseCredentials & { endpoint: string };
}

const SECRET_BYTES = 32;

/** Write-then-rename so a crash mid-write never leaves a truncated file. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[settings] unreadable ${file}, using defaults:`, err);
    return undefined;
  }
}

let current: AppSettings | null = null;
const listeners = new Set<(next: AppSettings, prev: AppSettings) => void>();

export function getSettings(): AppSettings {
  current ??= normalizeSettings(readJson(appPaths.settingsFile));
  return current;
}

export function setSettings(raw: unknown): AppSettings {
  const prev = getSettings();
  const next = normalizeSettings(raw);
  current = next;
  writeFileAtomic(appPaths.settingsFile, JSON.stringify(next, null, 2));
  for (const listener of listeners) listener(next, prev);
  return next;
}

export function onSettingsChange(listener: (next: AppSettings, prev: AppSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const newSecret = () => randomBytes(SECRET_BYTES).toString('base64url');
const newDatabaseKey = () => randomBytes(SECRET_BYTES).toString('hex');
const present = (v: unknown): v is string => typeof v === 'string' && v !== '';

async function encode(value: Secrets): Promise<Buffer> {
  const json = JSON.stringify(value);
  // safeStorage uses DPAPI on Windows; without it the file still stays in the user profile.
  return (await safeStorage.isAsyncEncryptionAvailable()) ? safeStorage.encryptStringAsync(json) : Buffer.from(json, 'utf8');
}

/** Parses secrets JSON; null when the text isn't a secrets object (ciphertext, corruption). */
function parseSecrets(json: string): { value: Secrets; complete: boolean } | null {
  let parsed: Partial<Secrets>;
  try { parsed = JSON.parse(json) as Partial<Secrets>; } catch { return null; }
  if (typeof parsed?.clientApiKey !== 'string') return null;
  let clickhouse: Secrets['clickhouse'];
  if (parsed.clickhouse) {
    try {
      if (typeof parsed.clickhouse.endpoint !== 'string') throw new Error('Missing credential binding');
      clickhouse = { ...validateClickHouseCredentials(parsed.clickhouse), endpoint: parsed.clickhouse.endpoint };
    }
    catch { console.error('[settings] invalid ClickHouse credentials ignored'); }
  }
  return {
    value: {
      clientApiKey: parsed.clientApiKey,
      managementKey: present(parsed.managementKey) ? parsed.managementKey : newSecret(),
      databaseKey: present(parsed.databaseKey) ? parsed.databaseKey : newDatabaseKey(),
      ...(clickhouse ? { clickhouse } : {}),
    },
    // Files from older versions lack later keys; they get them and are rewritten.
    complete: present(parsed.managementKey) && present(parsed.databaseKey),
  };
}

/** Reads an existing secrets file; throws when it can't (OS store locked or unavailable, corruption). */
async function decode(buf: Buffer): Promise<{ value: Secrets; reEncrypt: boolean }> {
  const encrypting = await safeStorage.isAsyncEncryptionAvailable();
  // Plain JSON was written while OS encryption was unavailable; encrypt it once it is.
  const plain = parseSecrets(buf.toString('utf8'));
  if (plain) return { value: plain.value, reEncrypt: encrypting || !plain.complete };
  if (!encrypting) throw new Error('OS encryption is unavailable');
  const r = await safeStorage.decryptStringAsync(buf);
  const decrypted = parseSecrets(r.result);
  if (!decrypted) throw new Error('decrypted secrets are malformed');
  return { value: decrypted.value, reEncrypt: r.shouldReEncrypt || !decrypted.complete };
}

/** What to do with a secrets file that can't be read: try again, set it aside and start new keys, or give up. */
export type SecretsRecovery = (error: unknown) => Promise<'retry' | 'reset' | 'quit'>;

let secrets: Secrets | null = null;

/**
 * Reads or creates the secrets file. Call once after app ready, before getSecrets().
 * An existing unreadable file is never replaced silently: `recover` decides; without it, or on quit, this throws.
 */
export async function loadSecrets(recover?: SecretsRecovery): Promise<Secrets> {
  const file = appPaths.secretsFile;
  let decoded: { value: Secrets; reEncrypt: boolean } | null = null;
  while (existsSync(file)) {
    try {
      decoded = await decode(readFileSync(file));
      break;
    } catch (err) {
      console.error('[settings] secrets unreadable:', err);
      const choice = recover ? await recover(err) : 'quit';
      if (choice === 'quit') throw err;
      if (choice === 'retry') continue;
      const aside = `${file}.unreadable-${Date.now()}`;
      renameSync(file, aside);
      console.error(`[settings] secrets reset; old file kept at ${aside}`);
    }
  }
  secrets = decoded?.value ?? { clientApiKey: newSecret(), managementKey: newSecret(), databaseKey: newDatabaseKey() };
  // Rewrite when new, stored as plain text, or encrypted under a rotated key.
  if (!decoded || decoded.reEncrypt) writeFileAtomic(file, await encode(secrets));
  return secrets;
}

export function getSecrets(): Secrets {
  if (!secrets) throw new Error('Secrets not loaded; call loadSecrets() after app ready');
  return secrets;
}

let secretWrites = Promise.resolve();
function mutateSecrets(change: (value: Secrets) => Secrets): Promise<void> {
  const operation = secretWrites.then(async () => {
    const next = change(getSecrets());
    writeFileAtomic(appPaths.secretsFile, await encode(next));
    secrets = next;
  });
  secretWrites = operation.catch(() => { /* The caller receives the failure; later writes may still succeed. */ });
  return operation;
}
export async function regenerateClientApiKey(): Promise<string> {
  const key = newSecret();
  await mutateSecrets((value) => ({ ...value, clientApiKey: key }));
  return key;
}
export function setClickHouseCredentials(raw: ClickHouseCredentials | null, endpoint = ''): Promise<void> {
  const credentials = raw === null ? undefined : { ...validateClickHouseCredentials(raw), endpoint };
  return mutateSecrets((value) => ({ ...value, clickhouse: credentials }));
}
