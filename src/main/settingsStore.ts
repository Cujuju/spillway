import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '@shared/app';
import { normalizeSettings, type AppSettings } from '@shared/settings';
import { appPaths } from './paths';

/** Secrets are generated locally and never leave this machine. */
interface Secrets {
  /** Key clients such as Claude Code send to the proxy. */
  clientApiKey: string;
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

async function encode(value: Secrets): Promise<Buffer> {
  const json = JSON.stringify(value);
  // safeStorage uses DPAPI on Windows; without it the file still stays in the user profile.
  return (await safeStorage.isAsyncEncryptionAvailable()) ? safeStorage.encryptStringAsync(json) : Buffer.from(json, 'utf8');
}

async function decode(buf: Buffer): Promise<{ value: Secrets; reEncrypt: boolean } | null> {
  try {
    let json = buf.toString('utf8');
    let reEncrypt = false;
    if (await safeStorage.isAsyncEncryptionAvailable()) {
      const r = await safeStorage.decryptStringAsync(buf);
      json = r.result;
      reEncrypt = r.shouldReEncrypt;
    }
    const parsed = JSON.parse(json) as Partial<Secrets>;
    // Files from before the per-launch supervisor password also hold a managementKey; it is dropped.
    if (typeof parsed.clientApiKey === 'string') return { value: { clientApiKey: parsed.clientApiKey }, reEncrypt: reEncrypt || 'managementKey' in parsed };
  } catch (err) {
    console.error('[settings] secrets unreadable:', err);
  }
  return null;
}

/** Decrypts the existing secrets file for print-key mode. Never creates or rewrites it. */
export async function readClientKey(): Promise<string> {
  const file = appPaths.secretsFile;
  if (!existsSync(file)) throw new Error(`No client key at ${file}; start ${APP_NAME} once first`);
  const decoded = await decode(readFileSync(file));
  if (!decoded) throw new Error(`Client key at ${file} is unreadable; open ${APP_NAME} to regenerate it`);
  return decoded.value.clientApiKey;
}

let secrets: Secrets | null = null;

/** Reads or creates the secrets file. Call once after app ready, before getSecrets(). */
export async function loadSecrets(): Promise<Secrets> {
  const file = appPaths.secretsFile;
  const decoded = existsSync(file) ? await decode(readFileSync(file)) : null;
  secrets = decoded?.value ?? { clientApiKey: newSecret() };
  // Rewrite when new, unreadable, or encrypted under a rotated key.
  if (!decoded || decoded.reEncrypt) writeFileAtomic(file, await encode(secrets));
  return secrets;
}

export function getSecrets(): Secrets {
  if (!secrets) throw new Error('Secrets not loaded; call loadSecrets() after app ready');
  return secrets;
}

export async function regenerateClientApiKey(): Promise<string> {
  const next = { ...getSecrets(), clientApiKey: newSecret() };
  writeFileAtomic(appPaths.secretsFile, await encode(next));
  secrets = next;
  return next.clientApiKey;
}
