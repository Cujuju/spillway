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

const target = { endpoint: 'http://127.0.0.1:8317', key: 'k1', keyCommand: { command: '/apps/spillway', args: ['--print-client-key'] } };
let home: string;
let files: ReturnType<typeof clientConfigFiles>;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'spillway-client-setup-'));
  files = clientConfigFiles({}, home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('client setup files', () => {
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
  });

  it('a rejected edit leaves the file and backup untouched', () => {
    const own = '[model_providers.spillway]\nname = "mine"\n';
    mkdirSync(path.dirname(files.codex), { recursive: true });
    writeFileSync(files.codex, own);
    expect(() => applyClient('codex', files.codex, target)).toThrow(/already defines/);
    expect(readFileSync(files.codex, 'utf8')).toBe(own);
    expect(existsSync(`${files.codex}${BACKUP_SUFFIX}`)).toBe(false);
  });

  it('reports an unreadable file as an error', () => {
    mkdirSync(path.dirname(files.claude), { recursive: true });
    writeFileSync(files.claude, '{ nope');
    expect(clientStatus('claude', files.claude, target, home).error).toMatch(/not valid JSON/);
  });
});
