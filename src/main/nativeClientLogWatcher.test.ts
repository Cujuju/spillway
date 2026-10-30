import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ClientLogWatcher } from './clientLogWatcher';

it.skipIf(process.platform !== 'darwin')('receives real native appends, populated moves and root recreation', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'spillway-native-'));
  const dir = path.join(base, 'projects');
  const file = path.join(dir, 'existing.jsonl');
  const dirty = vi.fn();
  const reconcile = vi.fn();
  const watcher = new ClientLogWatcher(dir, dirty, reconcile);
  try {
    await mkdir(dir); await writeFile(file, 'first\n');
    await watcher.refresh();
    expect(watcher.fallback).toBe(false);
    expect(watcher.needsPeriodicReconcile).toBe(false);
    await appendFile(file, 'append\n');
    await vi.waitFor(() => expect(dirty).toHaveBeenCalledWith(file), { timeout: 5000 });
    const staged = path.join(base, 'staged');
    await mkdir(path.join(staged, 'nested'), { recursive: true });
    await writeFile(path.join(staged, 'nested', 'child.jsonl'), 'moved\n');
    await rename(staged, path.join(dir, 'incoming'));
    await vi.waitFor(() => expect(dirty).toHaveBeenCalledWith(path.join(dir, 'incoming')), { timeout: 5000 });
    await rm(dir, { recursive: true });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalled(), { timeout: 5000 });
    await watcher.refresh(); reconcile.mockClear();
    await mkdir(dir);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalled(), { timeout: 5000 });
  } finally { await watcher.close(); await rm(base, { recursive: true, force: true }); }
}, 20_000);

it.skipIf(process.platform !== 'darwin')('watches a symlinked root and reports paths under the configured root', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'spillway-native-link-'));
  const parent = path.join(base, 'client');
  const target = path.join(base, 'logs');
  const dir = path.join(parent, 'projects');
  const dirty = vi.fn();
  const watcher = new ClientLogWatcher(dir, dirty, vi.fn());
  try {
    await mkdir(parent); await mkdir(target); await symlink(target, dir);
    await writeFile(path.join(target, 'a.jsonl'), 'initial\n');
    await watcher.refresh();
    expect(watcher.fallback).toBe(false);
    await appendFile(path.join(target, 'a.jsonl'), 'append\n');
    await vi.waitFor(() => expect(dirty).toHaveBeenCalledWith(path.join(dir, 'a.jsonl')), { timeout: 5000 });
  } finally { await watcher.close(); await rm(base, { recursive: true, force: true }); }
}, 10_000);
