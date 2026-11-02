/**
 * Claude Code's machine-wide managed policy: a drop-in file Spillway owns, read even by SDK apps passing
 * `settingSources: []`. The folder needs administrator rights, so writes use an elevation prompt.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CLAUDE_BASE_URL_VAR, CLAUDE_HEADERS_VAR, claudeKeyHeader } from '@shared/claudeEnv';
import type { ClientSetupState, ManagedPolicyStatus } from '@shared/types';
import type { ClientTarget } from './clientConfigText';

const run = promisify(execFile);

/** Claude Code's system directories: https://code.claude.com/docs/en/managed-settings */
const MANAGED_ROOTS: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'C:\\Program Files\\ClaudeCode',
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
};
/** Claude Code merges every JSON file here over managed-settings.json, so Spillway never edits a file it doesn't own. */
const DROP_IN_DIR = 'managed-settings.d';
const POLICY_FILE_NAME = 'spillway.json';
/** Claude Code writes settings with two-space indentation. */
const JSON_INDENT = 2;
/** Windows ERROR_CANCELLED: the user declined the UAC prompt. */
const WIN_CANCELLED = 1223;
/** AppleScript userCanceledErr: the user dismissed the password prompt. */
const MAC_CANCELLED = '(-128)';
/** Readable by every local user, as Claude Code requires; only the elevation can write it. */
const UNIX_FILE_MODE = '644';
/** pkexec exits 126 when the authentication dialog is dismissed. */
const PKEXEC_CANCELLED = 126;

export function managedPolicyFile(platform: NodeJS.Platform = process.platform): string | null {
  const root = MANAGED_ROOTS[platform];
  if (!root) return null;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(root, DROP_IN_DIR, POLICY_FILE_NAME);
}

export const policyText = (target: ClientTarget): string =>
  `${JSON.stringify({ env: { [CLAUDE_BASE_URL_VAR]: target.endpoint, [CLAUDE_HEADERS_VAR]: claudeKeyHeader(target.key) } }, null, JSON_INDENT)}\n`;

/** Spillway owns the file, so anything but its exact text (port, key or hand edit) is out of date. */
export const policyState = (text: string | null, target: ClientTarget): ClientSetupState =>
  text === null ? 'not-applied' : text === policyText(target) ? 'applied' : 'out-of-date';

export function managedPolicyStatus(target: ClientTarget, file = managedPolicyFile()): ManagedPolicyStatus | null {
  if (!file) return null;
  try {
    return { state: policyState(readFileSync(file, 'utf8'), target), path: file, error: null, monitored: false };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { state: 'not-applied', path: file, error: missing ? null : (err as Error).message, monitored: false };
  }
}

// ── Elevated file operations ──────────────────────────────────────

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Elevated PowerShell that copies `source` into place, or removes the file when `source` is null. */
export function windowsElevatedScript(file: string, source: string | null): string {
  const body = source === null
    ? `if (Test-Path -LiteralPath ${psQuote(file)}) { Remove-Item -LiteralPath ${psQuote(file)} -Force }`
    : `New-Item -ItemType Directory -Force -Path ${psQuote(path.win32.dirname(file))} | Out-Null; Copy-Item -LiteralPath ${psQuote(source)} -Destination ${psQuote(file)} -Force`;
  return `$ErrorActionPreference = 'Stop'; ${body}`;
}

/** Runs `inner` elevated via UAC and exits with its code; a declined prompt exits WIN_CANCELLED. */
export function windowsLauncher(inner: string): string {
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  return [
    'try {',
    `  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`,
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }',
    `  if ($e -and $e.NativeErrorCode -eq ${WIN_CANCELLED}) { exit ${WIN_CANCELLED} }`,
    '  throw',
    '}',
  ].join('\n');
}

/** AppleScript that runs the copy or removal as root after the password prompt. */
export function macElevatedScript(file: string, source: string | null): string {
  const shell = unixElevatedScript(file, source);
  return `do shell script "${shell.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
}

/** Shell commands shared by the macOS and Linux elevation launchers. */
export function unixElevatedScript(file: string, source: string | null): string {
  return source === null
    ? `/bin/rm -f ${shQuote(file)}`
    : `/bin/mkdir -p ${shQuote(path.posix.dirname(file))} && /bin/cp ${shQuote(source)} ${shQuote(file)} && /bin/chmod ${UNIX_FILE_MODE} ${shQuote(file)}`;
}

const DECLINED = 'Administrator approval was declined; nothing changed.';

async function elevated(file: string, source: string | null): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsLauncher(windowsElevatedScript(file, source))], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      await run('osascript', ['-e', macElevatedScript(file, source)]);
    } else if (process.platform === 'linux') {
      await run('pkexec', ['/bin/sh', '-c', unixElevatedScript(file, source)]);
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string };
    if (e.code === WIN_CANCELLED || e.code === PKEXEC_CANCELLED || e.stderr?.includes(MAC_CANCELLED)) throw new Error(DECLINED);
    if (process.platform === 'linux' && e.code === 'ENOENT') throw new Error('Install polkit (pkexec) to update the managed policy.');
    throw new Error(`Couldn't update ${file}${e.stderr ? `: ${e.stderr.trim()}` : ''}`);
  }
}

const requireFile = () => {
  const file = managedPolicyFile();
  if (!file) throw new Error('Managed policy is only supported on Windows, macOS and Linux');
  return file;
};

/** Writes the policy for the current endpoint and key. The staged copy lives in a private temp folder. */
export async function applyManagedPolicy(target: ClientTarget): Promise<void> {
  const file = requireFile();
  const staging = mkdtempSync(path.join(os.tmpdir(), 'spillway-policy-'));
  try {
    const source = path.join(staging, POLICY_FILE_NAME);
    writeFileSync(source, policyText(target), { mode: 0o600 });
    await elevated(file, source);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function undoManagedPolicy(target: ClientTarget, file = requireFile()): Promise<void> {
  if (managedPolicyStatus(target, file)?.state === 'not-applied') return;
  await elevated(file, null);
}
