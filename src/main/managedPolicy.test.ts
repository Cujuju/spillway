import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  macElevatedScript, managedPolicyFile, managedPolicyStatus, policyState, policyText, undoManagedPolicy, unixElevatedScript, windowsElevatedScript, windowsLauncher,
} from './managedPolicy';

const TARGET = { endpoint: 'http://127.0.0.1:8317', key: 'client-key' };

describe('managed policy file', () => {
  it('uses a drop-in Spillway owns under Claude Code’s managed folder', () => {
    expect(managedPolicyFile('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.d\\spillway.json');
    expect(managedPolicyFile('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.d/spillway.json');
    expect(managedPolicyFile('linux')).toBe('/etc/claude-code/managed-settings.d/spillway.json');
    expect(managedPolicyFile('freebsd')).toBeNull();
  });

  it('sets the endpoint and the key header, nothing else', () => {
    expect(JSON.parse(policyText(TARGET))).toEqual({ env: { ANTHROPIC_BASE_URL: TARGET.endpoint, ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: client-key' } });
  });

  it('is applied only when it holds the current endpoint and key', () => {
    expect(policyState(null, TARGET)).toBe('not-applied');
    expect(policyState(policyText(TARGET), TARGET)).toBe('applied');
    expect(policyState(policyText({ ...TARGET, key: 'old' }), TARGET)).toBe('out-of-date');
    expect(policyState('{ hand edited', TARGET)).toBe('out-of-date');
  });
});

describe('managed policy status', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('Undo on a missing policy completes without elevation or file writes', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-policy-test-'));
    const file = path.join(dir, 'spillway.json');
    await undoManagedPolicy(TARGET, file);
    expect(existsSync(file)).toBe(false);
  });

  it('reads a missing file as not applied and reports unreadable ones', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-policy-test-'));
    const file = path.join(dir, 'spillway.json');
    expect(managedPolicyStatus(TARGET, file)).toEqual({ state: 'not-applied', path: file, error: null, monitored: false });
    writeFileSync(file, policyText(TARGET));
    expect(managedPolicyStatus(TARGET, file)?.state).toBe('applied');
    // A folder at the path fails to read with something other than ENOENT.
    expect(managedPolicyStatus(TARGET, dir)?.error).toBeTruthy();
  });
});

describe('elevated scripts', () => {
  it('quotes Linux shell paths and makes the installed policy readable', () => {
    const file = "/etc/claude-code/managed-settings.d/it's.json";
    expect(unixElevatedScript(file, '/tmp/source file.json')).toBe(
      `/bin/mkdir -p '/etc/claude-code/managed-settings.d' && /bin/cp '/tmp/source file.json' '/etc/claude-code/managed-settings.d/it'\\''s.json' && /bin/chmod 644 '/etc/claude-code/managed-settings.d/it'\\''s.json'`,
    );
    expect(unixElevatedScript(file, null)).toBe(`/bin/rm -f '/etc/claude-code/managed-settings.d/it'\\''s.json'`);
  });
  it('quotes paths for PowerShell and encodes the elevated part', () => {
    expect(windowsElevatedScript("C:\\a b\\it's.json", "C:\\t\\x.json")).toContain("-Destination 'C:\\a b\\it''s.json'");
    const encoded = /'-EncodedCommand','([^']+)'/.exec(windowsLauncher('Write-Output 1'))?.[1] ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Write-Output 1');
  });

  it('quotes paths for the shell inside the AppleScript string', () => {
    const script = macElevatedScript("/Library/Application Support/ClaudeCode/managed-settings.d/it's.json", '/tmp/x.json');
    expect(script).toContain(`/bin/cp '/tmp/x.json' '/Library/Application Support/ClaudeCode/managed-settings.d/it'\\\\''s.json'`);
    expect(script).toMatch(/^do shell script ".*" with administrator privileges$/);
  });

  it.runIf(process.platform === 'win32')('builds a UAC launcher PowerShell parses without errors', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-launcher-'));
    try {
      const script = path.join(dir, 'launcher.ps1');
      writeFileSync(script, windowsLauncher(windowsElevatedScript('C:\\Program Files\\ClaudeCode\\managed-settings.d\\spillway.json', 'C:\\t\\x.json')));
      const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$e); $e.Count`;
      expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8' }).trim()).toBe('0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('copies the file into a new folder, then removes it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "spillway policy's-"));
    try {
      const source = path.join(dir, 'source.json');
      const file = path.join(dir, 'Claude Code', 'managed-settings.d', 'spillway.json');
      writeFileSync(source, policyText(TARGET));
      const ps = (script: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      ps(windowsElevatedScript(file, source));
      expect(readFileSync(file, 'utf8')).toBe(policyText(TARGET));
      ps(windowsElevatedScript(file, null));
      expect(existsSync(file)).toBe(false);
      ps(windowsElevatedScript(file, null));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
