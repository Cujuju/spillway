import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-secrets-'));
const secretsFile = path.join(dir, 'secrets.bin');

// Without OS encryption the file is plain JSON, which lets the test read it. `encrypting` stands in for Keychain, DPAPI or a keyring.
const storage = vi.hoisted(() => ({ encrypting: false, failedDecrypts: 0 }));
const CIPHER = 'cipher:';
vi.mock('electron', () => ({ safeStorage: {
  isAsyncEncryptionAvailable: async () => storage.encrypting,
  encryptStringAsync: async (text: string) => Buffer.from(CIPHER + text),
  async decryptStringAsync(buf: Buffer) {
    if (storage.failedDecrypts > 0) { storage.failedDecrypts--; throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.'); }
    return { result: buf.toString().slice(CIPHER.length), shouldReEncrypt: false };
  },
} }));
vi.mock('./paths', () => ({ appPaths: { secretsFile } }));

const { loadSecrets, setClickHouseCredentials, getSecrets, regenerateClientApiKey } = await import('./settingsStore');

const clearDir = () => { for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { force: true }); };
beforeEach(clearDir);
afterEach(() => { clearDir(); storage.encrypting = false; storage.failedDecrypts = 0; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('secrets', () => {
  it('preserves main-only destination credentials across reload and concurrent key changes', async () => {
    const initial = await loadSecrets();
    await Promise.all([setClickHouseCredentials({ username: 'export-user', password: 'export-secret' }), regenerateClientApiKey()]);
    expect(getSecrets().managementKey).toBe(initial.managementKey);
    expect((await loadSecrets()).clickhouse).toEqual({ username: 'export-user', password: 'export-secret', endpoint: '' });
    await setClickHouseCredentials(null); expect((await loadSecrets()).clickhouse).toBeUndefined();
  });
  it('keeps the management key across launches, so a tool given it once keeps working', async () => {
    const first = await loadSecrets();
    expect(first.managementKey).not.toBe('');
    expect(first.managementKey).not.toBe(first.clientApiKey);
    expect(await loadSecrets()).toEqual(first);
  });

  it('adds management and database keys to a file from before they existed, and keeps the client key', async () => {
    writeFileSync(secretsFile, JSON.stringify({ clientApiKey: 'old-client' }));
    const loaded = await loadSecrets();
    expect(loaded.clientApiKey).toBe('old-client');
    expect(loaded.databaseKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(secretsFile, 'utf8'))).toEqual(loaded);
  });
});

describe('an existing secrets file the OS store cannot decrypt', () => {
  async function encryptedFile() {
    storage.encrypting = true;
    const keys = await loadSecrets();
    return { keys, bytes: readFileSync(secretsFile) };
  }

  it('keeps the keys and the file when the store recovers on retry', async () => {
    const { keys, bytes } = await encryptedFile();
    storage.failedDecrypts = 1;
    const recover = vi.fn(async () => 'retry' as const);
    expect(await loadSecrets(recover)).toEqual(keys);
    expect(recover).toHaveBeenCalledOnce();
    expect(readFileSync(secretsFile)).toEqual(bytes);
  });

  it('fails without replacing anything when nothing decides, or the user quits', async () => {
    const { bytes } = await encryptedFile();
    storage.failedDecrypts = 2;
    await expect(loadSecrets()).rejects.toThrow(/decrypting/);
    await expect(loadSecrets(async () => 'quit')).rejects.toThrow(/decrypting/);
    expect(readFileSync(secretsFile)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(['secrets.bin']);
  });

  it('makes new keys only on an explicit reset, keeping the old file aside', async () => {
    const { keys, bytes } = await encryptedFile();
    storage.failedDecrypts = 1;
    const reset = await loadSecrets(async () => 'reset');
    expect(reset.databaseKey).not.toBe(keys.databaseKey);
    const aside = readdirSync(dir).find((name) => name.startsWith('secrets.bin.unreadable-'));
    expect(aside && readFileSync(path.join(dir, aside))).toEqual(bytes);
  });

  it('reads plain-text keys saved while encryption was unavailable, then encrypts them', async () => {
    const plain = await loadSecrets();
    storage.encrypting = true;
    const recover = vi.fn(async () => 'reset' as const);
    expect(await loadSecrets(recover)).toEqual(plain);
    expect(recover).not.toHaveBeenCalled();
    expect(readFileSync(secretsFile, 'utf8').startsWith(CIPHER)).toBe(true);
  });
});
