import { describe, expect, it } from 'vitest';
import { codexOwners, parseUnixProcesses, type ProcessRow } from './codexProcesses';

const CHATTYPOP_ELECTRON = 'E:\\Dev\\ChattyPop\\node_modules\\electron\\dist\\electron.exe';
const CODEX_EXE = 'C:\\npm\\@openai\\codex-win32-x64\\vendor\\bin\\codex.exe';
const T3 = 'C:\\Users\\me\\AppData\\Local\\Programs\\T3 Code\\T3 Code.exe';

const row = (pid: number, ppid: number, name: string, path: string | null, started: number | null = pid): ProcessRow =>
  ({ pid, ppid, name, path, started });

describe('codexOwners', () => {
  it('reads Linux ps names without treating equal names as a shared executable path', () => {
    const rows = parseUnixProcesses(' 60 1 t3-code\n61 60 node\n62 61 codex\ninvalid\n');
    expect(rows[0]?.path).toBeNull();
    expect(codexOwners(rows)).toEqual([{ pid: 60, app: 't3-code' }]);
    expect(parseUnixProcesses('40 1 /Applications/T3 Code.app/Contents/MacOS/T3 Code')[0]?.name).toBe('T3 Code');
  });
  it('names a dev Electron app after its project, past the node shim and Electron child processes', () => {
    const rows = [
      row(10, 1, 'electron.exe', CHATTYPOP_ELECTRON),
      row(11, 10, 'electron.exe', CHATTYPOP_ELECTRON),
      row(12, 11, 'node.exe', 'C:\\nodejs\\node.exe'),
      row(13, 12, 'codex.exe', CODEX_EXE),
      row(14, 13, 'codex-code-mode-host.exe', CODEX_EXE.replace('codex.exe', 'codex-code-mode-host.exe')),
    ];
    expect(codexOwners(rows)).toEqual([{ pid: 10, app: 'ChattyPop' }]);
  });

  it('names an installed app after its executable and lists it once for several Codex processes', () => {
    const rows = [row(20, 1, 'T3 Code.exe', T3), row(21, 20, 'codex.exe', CODEX_EXE), row(22, 20, 'codex.exe', CODEX_EXE)];
    expect(codexOwners(rows)).toEqual([{ pid: 20, app: 'T3 Code' }]);
  });

  it('stops at a parent id reused by a newer process and names the orphaned Codex', () => {
    // The node shim's real parent exited; pid 30 now belongs to a later, unrelated process.
    const rows = [row(30, 1, 'Spillway.exe', 'C:\\Spillway.exe', 500), row(31, 30, 'node.exe', 'C:\\nodejs\\node.exe', 100), row(32, 31, 'codex.exe', CODEX_EXE, 101)];
    expect(codexOwners(rows)).toEqual([{ pid: 31, app: 'Codex (process 32)' }]);
  });

  it('reads macOS rows, which have no start time', () => {
    const app = '/Applications/T3 Code.app/Contents/MacOS/T3 Code';
    const rows = [row(40, 1, 'T3 Code', app, null), row(41, 40, 'codex', '/opt/homebrew/bin/codex', null)];
    expect(codexOwners(rows)).toEqual([{ pid: 40, app: 'T3 Code' }]);
  });

  it('returns nothing when no Codex runs', () => {
    expect(codexOwners([row(50, 1, 'node.exe', null)])).toEqual([]);
  });
});
