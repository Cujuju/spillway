import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientSetupState } from '@shared/types';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, watch: vi.fn(fs.watch) };
});

vi.mock('./settingsStore', () => ({ writeFileAtomic: (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
} }));
const { ClientDrift } = await import('./clientDrift');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-drift-'));
  dirs.push(dir);
  const intentFile = path.join(dir, 'intent.json');
  let state: ClientSetupState = 'applied';
  let mode: 'warn' | 'reapply' = 'warn';
  let key = 'key1';
  const warn = vi.fn();
  const changed = vi.fn();
  const apply = vi.fn(() => { state = 'applied'; });
  const options = { intentFile, targets: [{ id: 'claude', file: path.join(dir, 'settings.json'), state: () => state, apply }],
    warn, changed, mode: () => mode, targetKey: () => key };
  const monitor = new ClientDrift(options);
  return { monitor, options, warn, changed, apply, intentFile,
    state: (next: ClientSetupState) => { state = next; },
    mode: (next: typeof mode) => { mode = next; }, key: (next: string) => { key = next; } };
}

it('persists Apply intent, detects closed-app drift at startup, and clears intent on Undo', () => {
  const f = fixture();
  f.monitor.setIntent('claude', true);
  expect(JSON.parse(readFileSync(f.intentFile, 'utf8'))).toEqual(['claude']);
  f.state('not-applied');
  const restarted = new ClientDrift(f.options);
  expect(restarted.monitored('claude')).toBe(true);
  restarted.check();
  restarted.check();
  expect(f.warn).toHaveBeenCalledTimes(1);
  f.mode('reapply');
  restarted.setIntent('claude', false);
  expect(restarted.monitored('claude')).toBe(false);
  restarted.check();
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(f.apply).not.toHaveBeenCalled();
});

it('warns on drift transitions and endpoint/key changes, broadcasts state changes', () => {
  const f = fixture();
  f.monitor.setIntent('claude', true);
  f.state('out-of-date');
  f.monitor.check();
  f.monitor.check();
  f.key('key2');
  f.monitor.check();
  expect(f.warn).toHaveBeenCalledTimes(2);
  expect(f.changed).toHaveBeenCalledTimes(2);
  f.state('applied');
  f.monitor.check();
  f.state('out-of-date');
  f.monitor.check();
  expect(f.warn).toHaveBeenCalledTimes(3);
});

it('repairs once and suppresses watch echoes; failed repairs warn once', () => {
  const f = fixture();
  f.monitor.setIntent('claude', true);
  f.mode('reapply');
  f.state('out-of-date');
  f.monitor.check();
  f.monitor.check();
  expect(f.apply).toHaveBeenCalledTimes(1);
  expect(f.warn).not.toHaveBeenCalled();
  f.apply.mockImplementation(() => { throw new Error('denied'); });
  f.state('not-applied');
  f.monitor.check();
  f.monitor.check();
  expect(f.apply).toHaveBeenCalledTimes(2);
  expect(f.warn).toHaveBeenCalledTimes(1);
});

it('warns for managed policy in reapply mode without attempting elevation', () => {
  const f = fixture();
  const monitor = new ClientDrift({ ...f.options, targets: [{ id: 'policy', file: f.intentFile, state: () => 'not-applied' }] });
  f.mode('reapply');
  monitor.setIntent('policy', true);
  monitor.check();
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(f.apply).not.toHaveBeenCalled();
});

it('bounds scheduled delay despite repeated target events and ignores unrelated directory writes', () => {
  const f = fixture();
  vi.useFakeTimers();
  f.monitor.start();
  const callback = vi.mocked(watch).mock.calls.at(-1)![1] as (event: string, filename: string | null) => void;
  const check = vi.spyOn(f.monitor, 'check');
  try {
    callback('change', 'history.jsonl');
    vi.advanceTimersByTime(200);
    expect(check).not.toHaveBeenCalled();
    callback('change', 'settings.json');
    vi.advanceTimersByTime(100);
    callback('change', 'settings.json');
    vi.advanceTimersByTime(50);
    expect(check).toHaveBeenCalledTimes(1);
    callback('rename', null);
    vi.advanceTimersByTime(150);
    expect(check).toHaveBeenCalledTimes(2);
  } finally { f.monitor.stop(); vi.useRealTimers(); }
});

it('watches the missing ancestor component', () => {
  const f = fixture();
  const monitor = new ClientDrift({ ...f.options, targets: [{ ...f.options.targets[0]!, file: path.join(path.dirname(f.intentFile), 'missing', 'nested', 'settings.json') }] });
  vi.useFakeTimers();
  monitor.start();
  const callback = vi.mocked(watch).mock.calls.at(-1)![1] as (event: string, filename: string | null) => void;
  const check = vi.spyOn(monitor, 'check');
  try {
    callback('rename', 'unrelated');
    vi.advanceTimersByTime(150);
    expect(check).not.toHaveBeenCalled();
    callback('rename', 'missing');
    vi.advanceTimersByTime(150);
    expect(check).toHaveBeenCalledTimes(1);
  } finally { monitor.stop(); vi.useRealTimers(); }
});

it('watches parent directories through file replacement and deletion', async () => {
  const f = fixture();
  const file = f.options.targets[0]!.file;
  writeFileSync(file, 'applied');
  const monitor = new ClientDrift({ ...f.options, targets: [{ id: 'claude', file,
    state: () => existsSync(file) ? readFileSync(file, 'utf8') === 'applied' ? 'applied' : 'out-of-date' : 'not-applied' }] });
  monitor.setIntent('claude', true);
  monitor.start();
  try {
    writeFileSync(`${file}.new`, 'drift');
    renameSync(`${file}.new`, file);
    await vi.waitFor(() => expect(f.warn).toHaveBeenCalledTimes(1));
    rmSync(file);
    await vi.waitFor(() => expect(f.warn).toHaveBeenCalledTimes(2));
  } finally { monitor.stop(); }
});
