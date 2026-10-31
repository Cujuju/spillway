import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./settingsStore', () => ({
  writeFileAtomic: (file: string, data: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  },
}));

const { applyClient, BACKUP_SUFFIX, clientConfigFiles, clientStatus, undoClient } = await import('./clientSetup');
const { CODEX_AUTH_FILE } = await import('./codexPoolAuth');

const target = { endpoint: 'http://127.0.0.1:8317', key: 'k1' };
const userLogin = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt_user"}}\n';
const poolLogin = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"spillway-pool"}}\n';
const codexAuth = () => path.join(path.dirname(files.codex), CODEX_AUTH_FILE);
let home: string;
let files: ReturnType<typeof clientConfigFiles>;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'spillway-client-setup-'));
  files = clientConfigFiles({}, home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('client setup files', () => {
  it('Undo preserves externally replaced configs when not applied and removes stale backups', () => {
    for (const client of ['claude', 'codex'] as const) {
      const file = files[client];
      mkdirSync(path.dirname(file), { recursive: true });
      const newer = client === 'claude' ? '{"theme":"new"}' : 'model = "new"\n';
      writeFileSync(file, newer);
      if (client === 'codex') writeFileSync(`${file}${BACKUP_SUFFIX}`, 'old backup');
      expect(clientStatus(client, file, target).state).toBe('not-applied');
      undoClient(client, file, target);
      expect(readFileSync(file, 'utf8')).toBe(newer);
      expect(existsSync(`${file}${BACKUP_SUFFIX}`)).toBe(false);
    }
  });
  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    const f = clientConfigFiles({ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' }, home);
    expect(f.claude).toBe(path.join('/c', 'settings.json'));
    expect(f.codex).toBe(path.join('/x', 'config.toml'));
  });

  it('Claude: backs up, applies, reports, and undo restores and removes the backup', () => {
    const original = '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://old"\n  }\n}\n';
    mkdirSync(path.dirname(files.claude), { recursive: true });
    writeFileSync(files.claude, original);
    expect(clientStatus('claude', files.claude, target, home)).toMatchObject({ state: 'not-applied', path: path.join('~', '.claude', 'settings.json') });

    applyClient('claude', files.claude, target);
    expect(readFileSync(`${files.claude}${BACKUP_SUFFIX}`, 'utf8')).toBe(original);
    expect(clientStatus('claude', files.claude, target, home).state).toBe('applied');
    expect(clientStatus('claude', files.claude, { ...target, key: 'k2' }, home).state).toBe('out-of-date');

    // A re-apply keeps the first backup.
    applyClient('claude', files.claude, { ...target, key: 'k2' });
    expect(readFileSync(`${files.claude}${BACKUP_SUFFIX}`, 'utf8')).toBe(original);

    undoClient('claude', files.claude);
    expect(readFileSync(files.claude, 'utf8')).toBe(original);
    expect(existsSync(`${files.claude}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('missing files are created, and undo deletes them again', () => {
    for (const client of ['claude', 'codex'] as const) {
      applyClient(client, files[client], target);
      expect(clientStatus(client, files[client], target, home).state).toBe('applied');
      undoClient(client, files[client]);
      expect(existsSync(files[client])).toBe(false);
      expect(existsSync(`${files[client]}${BACKUP_SUFFIX}`)).toBe(false);
    }
    expect(existsSync(codexAuth())).toBe(false);
    expect(existsSync(`${codexAuth()}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it("Codex: apply leaves the user's own login alone", () => {
    mkdirSync(path.dirname(codexAuth()), { recursive: true });
    writeFileSync(codexAuth(), userLogin);
    applyClient('codex', files.codex, target);
    expect(readFileSync(codexAuth(), 'utf8')).toBe(userLogin);
    expect(readFileSync(files.codex, 'utf8')).not.toMatch(/chatgpt_base_url|cli_auth_credentials_store/);
    undoClient('codex', files.codex);
    expect(readFileSync(codexAuth(), 'utf8')).toBe(userLogin);
  });

  it("Codex: apply retires an earlier pool login and puts the user's login back", () => {
    mkdirSync(path.dirname(codexAuth()), { recursive: true });
    writeFileSync(codexAuth(), poolLogin);
    writeFileSync(`${codexAuth()}${BACKUP_SUFFIX}`, userLogin);
    applyClient('codex', files.codex, target);
    expect(readFileSync(codexAuth(), 'utf8')).toBe(userLogin);
    expect(existsSync(`${codexAuth()}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('Codex: a pool login with no saved login is removed, so Codex asks to sign in', () => {
    mkdirSync(path.dirname(codexAuth()), { recursive: true });
    writeFileSync(codexAuth(), poolLogin);
    writeFileSync(`${codexAuth()}${BACKUP_SUFFIX}`, '');
    undoClient('codex', files.codex);
    expect(existsSync(codexAuth())).toBe(false);
    expect(existsSync(`${codexAuth()}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('Codex: a login made since the pool login is kept over the old backup', () => {
    mkdirSync(path.dirname(codexAuth()), { recursive: true });
    writeFileSync(codexAuth(), userLogin);
    writeFileSync(`${codexAuth()}${BACKUP_SUFFIX}`, '{"old":true}\n');
    applyClient('codex', files.codex, target);
    expect(readFileSync(codexAuth(), 'utf8')).toBe(userLogin);
    expect(existsSync(`${codexAuth()}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('a rejected edit leaves the file and backup untouched', () => {
    const own = '# >>> spillway\nmodel = "o3"\n';
    mkdirSync(path.dirname(files.codex), { recursive: true });
    writeFileSync(files.codex, own);
    expect(() => applyClient('codex', files.codex, target)).toThrow(/without/);
    expect(readFileSync(files.codex, 'utf8')).toBe(own);
    expect(existsSync(`${files.codex}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('reports an unreadable file as an error', () => {
    mkdirSync(path.dirname(files.claude), { recursive: true });
    writeFileSync(files.claude, '{ nope');
    expect(clientStatus('claude', files.claude, target, home).error).toMatch(/not valid JSON/);
  });
});
