import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ClientProcess } from '@shared/types';

const run = promisify(execFile);
/** Listing every process is a one-off call per Apply; a slower one counts as unavailable. */
const LIST_TIMEOUT_MS = 15_000;
/** A few hundred processes as JSON stay well under this. */
const LIST_MAX_BUFFER = 32 * 1024 * 1024;
/** The native Codex binary; its helpers (codex-code-mode-host) have other names. */
const CODEX = /^codex(\.exe)?$/i;
/** Processes between an app and its Codex: npm's node shim, shells and console hosts. */
const LAUNCHER = /^(codex|node|cmd|powershell|pwsh|conhost|bash|zsh|sh|fish|bun)(\.exe)?$/i;
const NODE_MODULES = 'node_modules';

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  path: string | null;
  /** Start time in ms; null where the platform listing has none. */
  started: number | null;
}

/** Windows keeps a dead parent's id, which a newer process can reuse; a parent never starts after its child. */
function parentOf(row: ProcessRow, byPid: Map<number, ProcessRow>): ProcessRow | null {
  const parent = byPid.get(row.ppid);
  if (!parent || parent.pid === row.pid) return null;
  if (parent.started !== null && row.started !== null && parent.started > row.started) return null;
  return parent;
}

/** A dev Electron app runs from <project>/node_modules/electron; name it after the project. */
export function appLabel(row: ProcessRow): string {
  const file = row.path ?? row.name;
  const parts = file.split(/[\\/]/);
  const modules = parts.indexOf(NODE_MODULES);
  const project = modules > 0 ? parts[modules - 1] : undefined;
  if (project) return project;
  return (parts[parts.length - 1] ?? file).replace(/\.exe$/i, '');
}

/** The app that started each running Codex: its first ancestor that is not a launcher or a child process of the same app. */
export function codexOwners(rows: ProcessRow[]): ClientProcess[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const owners = new Map<number, ClientProcess>();
  for (const codex of rows.filter((r) => CODEX.test(r.name))) {
    let owner = codex;
    for (let p = parentOf(owner, byPid); p && LAUNCHER.test(owner.name); p = parentOf(owner, byPid)) owner = p;
    // Electron's utility and renderer processes share the main process's executable.
    for (let p = parentOf(owner, byPid); p && owner.path !== null && p.path === owner.path; p = parentOf(owner, byPid)) owner = p;
    // A launcher left at the top means the app that started this Codex has exited.
    const app = LAUNCHER.test(owner.name) ? `Codex (process ${codex.pid})` : appLabel(owner);
    if (!owners.has(owner.pid)) owners.set(owner.pid, { pid: owner.pid, app });
  }
  return [...owners.values()];
}

const WINDOWS_LIST =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,' +
  '@{n="Started";e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress';

async function listWindows(): Promise<ProcessRow[]> {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST], {
    timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, windowsHide: true,
  });
  const parsed = JSON.parse(stdout) as unknown;
  const items = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
  return items.map((p) => ({
    pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name ?? ''),
    path: typeof p.ExecutablePath === 'string' ? p.ExecutablePath : null,
    started: typeof p.Started === 'number' ? p.Started : null,
  }));
}

/** Unix re-parents orphans to pid 1, so parent ids are never stale and need no start time. */
async function listUnix(): Promise<ProcessRow[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER });
  return stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) return [];
    const [, pid = '', ppid = '', file = ''] = m;
    return [{ pid: Number(pid), ppid: Number(ppid), name: path.basename(file), path: file, started: null }];
  });
}

/** Apps running a Codex now; null when the process list can't be read. */
export async function runningCodexApps(): Promise<ClientProcess[] | null> {
  try {
    return codexOwners(process.platform === 'win32' ? await listWindows() : await listUnix());
  } catch {
    return null;
  }
}
