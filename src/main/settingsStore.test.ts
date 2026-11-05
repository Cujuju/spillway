import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-secrets-'));
const secretsFile = path.join(dir, 'secrets.bin');

// Without OS encryption the file is plain JSON, which lets the test read it.
vi.mock('electron', () => ({ safeStorage: { isAsyncEncryptionAvailable: async () => false } }));
vi.mock('./paths', () => ({ appPaths: { secretsFile } }));

const { loadSecrets, setClickHouseCredentials, getSecrets, regenerateClientApiKey } = await import('./settingsStore');

beforeEach(() => rmSync(secretsFile, { force: true }));
afterEach(() => rmSync(secretsFile, { force: true }));
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
