import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ActivityStorage } from './activityStorage';

let sandbox: string, profile: string, custom: string;
beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'spillway-storage-'));
  profile = path.join(sandbox, 'profile');
  custom = path.join(sandbox, 'custom');
  await mkdir(path.join(profile, 'proxy'), { recursive: true });
  await mkdir(custom);
});
afterEach(async () => rm(sandbox, { recursive: true, force: true }));

const put = (root: string, name: string, content: string) => writeFile(path.join(root, name), content);
const get = (root: string, name: string) => readFile(path.join(root, name), 'utf8');

it('moves growing files together, keeps profile files, and can return to the default', async () => {
  const storage = new ActivityStorage(profile);
  await storage.initialize();
  expect(storage.directory).toBe(storage.defaultDirectory);
  const entries = [
    'activity.db', 'activity.db-wal', 'activity.db.pre-merge-123', 'activity.db-wal.pre-merge-123',
    'usage-history.json', 'window-summaries.json', 'observed-spans.json', 'proxy/captures.db', 'proxy/proxy.log',
  ];
  await Promise.all(entries.map((entry) => put(profile, entry, entry)));
  await mkdir(path.join(profile, 'activity'));
  await put(profile, 'activity/2026-11-19.jsonl', 'legacy');
  await put(profile, 'settings.json', 'preferences');
  await put(profile, 'secrets.bin', 'encrypted keys');
  await put(profile, 'proxy/config.yaml', 'proxy settings');
  const destination = (await storage.destination(custom, false))!;
  await storage.schedule(destination);

  const restarted = new ActivityStorage(profile);
  await expect(restarted.initialize()).resolves.toBeUndefined();
  expect(restarted.directory).toBe(destination.directory);
  for (const entry of entries) {
    await expect(get(destination.directory, entry)).resolves.toBe(entry);
    await expect(get(profile, entry)).rejects.toHaveProperty('code', 'ENOENT');
  }
  await expect(get(destination.directory, 'activity/2026-11-19.jsonl')).resolves.toBe('legacy');
  await expect(get(profile, 'settings.json')).resolves.toBe('preferences');
  await expect(get(profile, 'secrets.bin')).resolves.toBe('encrypted keys');
  await expect(get(profile, 'proxy/config.yaml')).resolves.toBe('proxy settings');
  await expect(restarted.destination(custom, false)).resolves.toBeNull();

  await put(destination.directory, 'user-file.txt', 'keep');
  await restarted.schedule((await restarted.destination('', true))!);
  const restored = new ActivityStorage(profile);
  await expect(restored.initialize()).resolves.toBeUndefined();
  expect(restored.directory).toBe(restored.defaultDirectory);
  await expect(get(restored.directory, 'activity.db')).resolves.toBe('activity.db');
  await expect(get(destination.directory, 'activity.db')).rejects.toHaveProperty('code', 'ENOENT');
  await expect(get(destination.directory, 'user-file.txt')).resolves.toBe('keep');
});

it('keeps the current data if a destination becomes occupied after confirmation', async () => {
  const storage = new ActivityStorage(profile);
  await put(profile, 'activity.db', 'original');
  const destination = (await storage.destination(custom, false))!;
  await storage.schedule(destination);
  await mkdir(destination.directory);
  await put(destination.directory, 'activity.db', 'other profile');
  const restarted = new ActivityStorage(profile);
  await expect(restarted.initialize()).resolves.toContain('Could not move data');
  await expect(get(profile, 'activity.db')).resolves.toBe('original');
  await expect(get(destination.directory, 'activity.db')).resolves.toBe('other profile');
  await expect(new ActivityStorage(profile).initialize()).resolves.toBeUndefined();
});

it('recovers a published move after interruption and rejects a missing active drive', async () => {
  const storage = new ActivityStorage(profile);
  await put(profile, 'activity.db', 'original');
  const destination = (await storage.destination(custom, false))!;
  await storage.schedule(destination);
  const { pending } = JSON.parse(await get(profile, 'activity-storage.json')) as { pending: { id: string } };
  await mkdir(destination.directory);
  await put(destination.directory, 'activity.db', 'original');
  await put(destination.directory, '.spillway-storage', pending.id);

  const restarted = new ActivityStorage(profile);
  await expect(restarted.initialize()).resolves.toBeUndefined();
  expect(restarted.directory).toBe(destination.directory);
  await expect(get(profile, 'activity.db')).rejects.toHaveProperty('code', 'ENOENT');
  await rm(custom, { recursive: true });
  await expect(new ActivityStorage(profile).initialize()).rejects.toThrow('Storage folder unavailable');
});
