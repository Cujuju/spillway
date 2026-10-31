import { EventEmitter } from 'node:events';
import { watch, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, appendFile, rm, stat, readdir, utimes, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CLIENT_LOG_POLL_MS, CLIENT_LOG_RECONCILE_MS, startClientLogSync, importClientFile } from './clientLogSync';
import { ClientLogWatcher, CLIENT_LOG_WATCH_RETRY_MS } from './clientLogWatcher';
import { loadNativeClientLogEvents, type NativeClientLogEvents } from './nativeClientLogWatcher';
import { ActivityLog } from './activityStore';
import { parseClientLine } from './clientLogParser';
import type { ActivityImportState } from '@shared/ipc';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('./nativeClientLogWatcher', async (original) => ({
  ...await original<typeof import('./nativeClientLogWatcher')>(), loadNativeClientLogEvents: vi.fn(() => null),
}));
const nativeHandles: { dir: string; emit: (file: string, flags: number) => void; stop: ReturnType<typeof vi.fn> }[] = [];
const native: NativeClientLogEvents = {
  constants: { MustScanSubDirs: 1, UserDropped: 2, KernelDropped: 4, EventIdsWrapped: 8, RootChanged: 32,
    Mount: 64, Unmount: 128, ItemCreated: 256, ItemRemoved: 512, ItemRenamed: 2048, ItemIsDir: 131072 },
  watch: (dir, emit) => {
    const stop = vi.fn(async () => {});
    nativeHandles.push({ dir, emit, stop });
    return stop;
  },
};
const handles: { dir: string; recursive: boolean; emit: (event: string, filename: string | null) => void; handle: EventEmitter & { close: ReturnType<typeof vi.fn> } }[] = [];
let dir: string;
let log: ActivityLog;
let stop: (() => Promise<void>) | undefined;
const line = (id: string, tokens = 1) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), sessionId: 's',
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: tokens } } }) + '\n';
let idle: (() => void) | undefined;
let nextIdle: Promise<void>;
const progress = vi.fn((p: ActivityImportState) => { if (p.state === 'idle') idle?.(); });
function waitIdle() { nextIdle = new Promise<void>((resolve) => { idle = resolve; }); return nextIdle; }
const changed = vi.fn();
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  handles.length = 0;
  nativeHandles.length = 0;
  vi.mocked(loadNativeClientLogEvents).mockReturnValue(null);
  changed.mockClear(); progress.mockClear();
  vi.mocked(watch).mockImplementation(((root: string, options: unknown, listener?: (event: string, filename: string | null) => void) => {
    if (!existsSync(root)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
    handles.push({ dir: root, recursive: typeof options !== 'function', emit: typeof options === 'function' ? options : listener, handle } as typeof handles[number]);
    return handle;
  }) as unknown as typeof watch);
  dir = await mkdtemp(path.join(tmpdir(), 'spillway-watch-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir); vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  await mkdir(path.join(dir, 'projects', 'old', 'subagents'), { recursive: true });
  await mkdir(path.join(dir, 'codex', 'sessions'), { recursive: true });
  log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 30 });
});
afterEach(async () => {
  await stop?.(); stop = undefined;
  log.close(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const file = () => path.join(dir, 'projects', 'old', 'subagents', 'old.jsonl');
async function start() { const done = waitIdle(); stop = startClientLogSync(log, changed, progress); await done; }
async function poll() { const done = waitIdle(); await vi.advanceTimersByTimeAsync(CLIENT_LOG_POLL_MS); await done; }
/** A poll that finds a directory schedules an immediate full walk. */
async function pollAndWalk() { await poll(); const done = waitIdle(); await vi.advanceTimersByTimeAsync(1); await done; }
function nativeRoot() { return nativeHandles[0]!; }
function root() { return handles.findLast((h) => h.dir === path.join(dir, 'projects') && h.recursive)!; }

it('imports old-file appends without walking and does no filesystem work on an idle poll', async () => {
  await writeFile(file(), line('a')); await start();
  vi.mocked(stat).mockClear(); vi.mocked(readdir).mockClear();
  await poll();
  expect(stat).not.toHaveBeenCalled(); expect(readdir).not.toHaveBeenCalled();
  await appendFile(file(), line('b'));
  root().emit('change', path.relative(path.join(dir, 'projects'), file()));
  await poll();
  expect(readdir).not.toHaveBeenCalled(); expect(stat).toHaveBeenCalledTimes(1);
  expect(log.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(2);
});

it.each(['null', 'error', 'replacement'])('reconciles immediately on %s and closes watchers', async (event) => {
  await start(); vi.mocked(readdir).mockClear();
  const done = waitIdle();
  if (event === 'null') root().emit('change', null);
  else if (event === 'error') root().handle.emit('error', new Error('lost watch'));
  else handles.find((h) => h.dir === dir)!.emit('rename', 'projects');
  await vi.advanceTimersByTimeAsync(0); await done;
  expect(readdir).toHaveBeenCalled();
  await stop!();
  expect(handles.every((h) => h.handle.close.mock.calls.length === 1)).toBe(true);
  const oldHandles = handles.slice();
  await start();
  expect(oldHandles.every((h) => h.handle.close.mock.calls.length === 1)).toBe(true);
  expect(handles.length).toBeGreaterThan(oldHandles.length);
});

it('falls back to polling if watch creation fails and logs once', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(watch).mockImplementation(() => { throw new Error('unsupported'); });
  await start(); await writeFile(file(), line('new')); await poll();
  expect(log.totalsList()).toHaveLength(1);
  await poll(); expect(warning).toHaveBeenCalledTimes(2); // Once per root.
});

it('discovers a missing root from its nearest existing ancestor', async () => {
  await rm(path.join(dir, 'projects'), { recursive: true }); await start();
  await mkdir(path.dirname(file()), { recursive: true }); await writeFile(file(), line('appeared'));
  const done = waitIdle(); handles.find((h) => h.dir === dir)!.emit('rename', 'projects');
  await vi.advanceTimersByTimeAsync(0); await done;
  expect(log.totalsList()).toHaveLength(1); expect(root()).toBeDefined();
});

function onPlatform(platform: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  return () => Object.defineProperty(process, 'platform', original);
}

it('reconciles at five minutes on a Node watcher that hides drops', async () => {
  const restore = onPlatform('darwin');
  try {
    await start(); await writeFile(file(), line('missed'));
    for (let n = 0; n < CLIENT_LOG_RECONCILE_MS / CLIENT_LOG_POLL_MS; n++) await poll();
    expect(log.totalsList()).toHaveLength(1);
  } finally { restore(); }
});

it('never sweeps on a timer on Windows, whose watcher reports drops', async () => {
  const restore = onPlatform('win32');
  try {
    await start(); vi.mocked(readdir).mockClear();
    for (let n = 0; n < 2 * CLIENT_LOG_RECONCILE_MS / CLIENT_LOG_POLL_MS; n++) await poll();
    expect(readdir).not.toHaveBeenCalled();
  } finally { restore(); }
});

it('retains events arriving during an active scan for the next poll', async () => {
  await writeFile(file(), line('first'));
  const original = log.importBatch.bind(log);
  let injected = false;
  vi.spyOn(log, 'importBatch').mockImplementation((f, s, events) => {
    if (!injected && events.length) { injected = true; root().emit('change', path.relative(path.join(dir, 'projects'), file())); }
    return original(f, s, events);
  });
  await start();
  await appendFile(file(), line('later'));
  await poll();
  expect(log.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(2);
});

it('emits resets for coverage-only matches and usage replacement, but not replay', async () => {
  const first = line('matched');
  const event = parseClientLine(first, 'claude', {})!;
  log.append({ ...event, source: 'proxy', requestId: 'proxy', authIndex: 'account' });
  expect(log.coverage().clients).toEqual([]);
  await writeFile(file(), first); await start();
  expect(log.coverage().clients).toEqual([expect.objectContaining({ requests: 1, viaProxy: 1 })]);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(log.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(1);
  await appendFile(file(), line('matched', 5)); root().emit('change', path.relative(path.join(dir, 'projects'), file()));
  await poll(); // Matched proxy usage remains authoritative.
  await appendFile(file(), line('local', 2)); root().emit('change', path.relative(path.join(dir, 'projects'), file()));
  await poll();
  const before = changed.mock.calls.length;
  await appendFile(file(), line('local', 8)); root().emit('change', path.relative(path.join(dir, 'projects'), file()));
  await poll(); expect(changed).toHaveBeenCalledTimes(before + 1);
  const totals = log.totalsList();
  const info = await stat(file()); await utimes(file(), info.atime, new Date(info.mtimeMs - 10_000));
  await importClientFile(file(), 'claude', log);
  expect(log.totalsList()).toEqual(totals);
});

it.each([false, true])('delivers clock-controlled long-scan progress and final idle (cancel: %s)', async (cancel) => {
  await writeFile(file(), Array.from({ length: 1000 }, (_, i) => line(String(i))).join(''));
  const original = log.importBatch.bind(log);
  let batches = 0;
  vi.spyOn(log, 'importBatch').mockImplementation((...args) => {
    vi.setSystemTime(Date.now() + 100);
    const result = original(...args); batches++;
    if (cancel && batches === 2) void stop!();
    return result;
  });
  await start();
  const updates = progress.mock.calls.map(([p]) => p);
  expect(updates.filter((p) => p.state === 'importing').length).toBeGreaterThan(2);
  expect(updates.at(-1)?.state).toBe('idle');
  expect(updates.at(-1)?.recordsImported).toBe(cancel ? 256 : 1000);
  expect(JSON.parse(log.checkpoint(file())!).complete).toBe(cancel ? undefined : true);
});

it('bounds repeated asynchronous failures to one immediate scan and recovers on the retry cadence', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await start();
  const failed = root();
  const count = handles.length;
  vi.mocked(readdir).mockClear();
  const done = waitIdle();
  failed.handle.emit('error', new Error('lost'));
  await done;
  const walks = vi.mocked(readdir).mock.calls.length;
  for (let n = 0; n < 5; n++) failed.handle.emit('error', new Error('still lost'));
  await vi.advanceTimersByTimeAsync(0);
  expect(readdir).toHaveBeenCalledTimes(walks);
  expect(handles.filter((h) => h.dir === failed.dir && h.recursive)).toHaveLength(1);
  expect(handles.length).toBeGreaterThanOrEqual(count);
  for (let n = 0; n < CLIENT_LOG_WATCH_RETRY_MS / CLIENT_LOG_POLL_MS; n++) await poll();
  expect(root()).not.toBe(failed);
  vi.mocked(readdir).mockClear();
  await poll();
  expect(readdir).not.toHaveBeenCalled();
  await stop!();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['archive.jsonl', 'x.jsonl.zst', 'ordinary'])('discovers populated renamed directories named %s', async (name) => {
  await start();
  const source = path.join(dir, 'staged');
  await mkdir(path.join(source, 'nested'), { recursive: true });
  await writeFile(path.join(source, 'nested', 'child.jsonl'), line('child'));
  await rename(source, path.join(dir, 'projects', name));
  vi.mocked(readdir).mockClear();
  root().emit('rename', name); await pollAndWalk();
  expect(readdir).toHaveBeenCalled();
  expect(log.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(1);
  const batch = vi.spyOn(log, 'importBatch');
  root().emit('change', name); await poll();
  expect(batch).not.toHaveBeenCalled();
  expect(progress.mock.calls.at(-1)?.[0].error).toBeNull();
  await poll(); expect(batch).not.toHaveBeenCalled();
});

it('retries a failed import on the next poll', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await start(); await writeFile(file(), line('retry'));
  vi.spyOn(log, 'importBatch').mockImplementationOnce(() => { throw new Error('locked'); });
  root().emit('change', path.relative(path.join(dir, 'projects'), file()));
  await poll(); expect(log.totalsList()).toHaveLength(0);
  await poll(); expect(log.totalsList()).toHaveLength(1);
});

it('advances through multiple missing ancestors', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'missing', 'config'));
  await start();
  await mkdir(path.join(dir, 'missing'));
  let done = waitIdle(); handles.findLast((h) => h.dir === dir)!.emit('rename', 'missing'); await done;
  await mkdir(path.join(dir, 'missing', 'config'));
  done = waitIdle(); handles.findLast((h) => h.dir === path.join(dir, 'missing'))!.emit('rename', 'config'); await done;
  const projects = path.join(dir, 'missing', 'config', 'projects');
  await mkdir(projects); await writeFile(path.join(projects, 'a.jsonl'), line('deep'));
  done = waitIdle(); handles.findLast((h) => h.dir === path.dirname(projects))!.emit('rename', 'projects'); await done;
  expect(log.totalsList()).toHaveLength(1);
});

it('requests only one immediate reconciliation across repeated failing watcher creations', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reconcile = vi.fn();
  const watcher = new ClientLogWatcher(path.join(dir, 'projects'), vi.fn(), reconcile);
  try {
    await watcher.refresh();
    for (let n = 0; n < 4; n++) {
      root().handle.emit('error', new Error('lost'));
      expect(watcher.fallback).toBe(true);
      await watcher.refresh();
      expect(watcher.fallback).toBe(true);
      vi.setSystemTime(Date.now() + CLIENT_LOG_WATCH_RETRY_MS);
      await watcher.refresh();
    }
    expect(reconcile).toHaveBeenCalledTimes(1);
  } finally { await watcher.close(); }
});

it.each([['archive.jsonl', 'rename'], ['x.jsonl.zst', 'rename'], ['archive.jsonl', 'change']])('discovers a newly populated directory named %s from a %s event', async (name, event) => {
  await start();
  const nested = path.join(dir, 'projects', name, 'nested');
  await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, 'child.jsonl'), line('created'));
  root().emit(event, name); await pollAndWalk();
  expect(log.totalsList()).toHaveLength(1);
  expect(progress.mock.calls.at(-1)?.[0].error).toBeNull();
});

it('imports a newly created log file without a full walk', async () => {
  await start(); vi.mocked(readdir).mockClear();
  await writeFile(path.join(dir, 'projects', 'new.jsonl'), line('fresh'));
  root().emit('rename', 'new.jsonl'); await poll();
  expect(readdir).not.toHaveBeenCalled();
  expect(log.totalsList()).toHaveLength(1);
});

it('uses native events for appends and stays idle beyond the old reconciliation interval', async () => {
  vi.mocked(loadNativeClientLogEvents).mockReturnValue(native);
  await writeFile(file(), line('first')); await start();
  vi.mocked(stat).mockClear(); vi.mocked(readdir).mockClear();
  for (let n = 0; n < 2 * CLIENT_LOG_RECONCILE_MS / CLIENT_LOG_POLL_MS; n++) await poll();
  expect(readdir).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
  await appendFile(file(), line('append'));
  nativeRoot().emit(path.join(nativeRoot().dir, 'projects', 'old', 'subagents', 'old.jsonl'), 0);
  await poll();
  expect(log.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(2);
  expect(readdir).not.toHaveBeenCalled();
  await stop!();
  expect(nativeHandles.every((h) => h.stop.mock.calls.length === 1)).toBe(true);
});

it.each(['MustScanSubDirs', 'UserDropped', 'KernelDropped', 'EventIdsWrapped', 'RootChanged', 'Mount', 'Unmount'] as const)(
  'recovers missed native events on %s, including flags outside the client subtree', async (flag) => {
    vi.mocked(loadNativeClientLogEvents).mockReturnValue(native);
    await start(); await writeFile(file(), line('missed'));
    const old = nativeRoot();
    const done = waitIdle(); old.emit(old.dir, native.constants[flag]); await done;
    expect(log.totalsList()).toHaveLength(1);
    expect(old.stop).toHaveBeenCalledTimes(1);
    vi.mocked(readdir).mockClear();
    old.emit(old.dir, native.constants[flag]);
    await poll(); expect(readdir).not.toHaveBeenCalled();
  },
);

it('finds populated native directory moves without descendant notifications', async () => {
  vi.mocked(loadNativeClientLogEvents).mockReturnValue(native);
  await start();
  const nested = path.join(dir, 'projects', 'archive.jsonl', 'nested');
  await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, 'child.jsonl'), line('moved'));
  nativeRoot().emit(path.join(nativeRoot().dir, 'projects', 'archive.jsonl'), native.constants.ItemIsDir | native.constants.ItemRenamed);
  await pollAndWalk(); expect(log.totalsList()).toHaveLength(1);
});

it('ignores unrelated native paths and follows missing ancestors and root replacement', async () => {
  vi.mocked(loadNativeClientLogEvents).mockReturnValue(native);
  await rm(path.join(dir, 'projects'), { recursive: true });
  await start(); vi.mocked(readdir).mockClear();
  nativeRoot().emit(path.join(nativeRoot().dir, 'unrelated.jsonl'), 0);
  await poll(); expect(readdir).not.toHaveBeenCalled();
  await mkdir(path.dirname(file()), { recursive: true }); await writeFile(file(), line('new-root'));
  let done = waitIdle();
  nativeRoot().emit(path.join(nativeRoot().dir, 'projects'), native.constants.ItemIsDir | native.constants.ItemCreated);
  await done; expect(log.totalsList()).toHaveLength(1);
  await rename(path.join(dir, 'projects'), path.join(dir, 'retired'));
  await mkdir(path.dirname(file()), { recursive: true }); await writeFile(file(), line('replaced'));
  const current = nativeHandles.findLast((h) => h.dir === nativeRoot().dir)!;
  done = waitIdle(); current.emit(path.join(current.dir, 'projects'), native.constants.ItemIsDir | native.constants.ItemRenamed);
  await done; expect(log.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(2);
});

it.each(['load', 'watch'])('polls when native %s fails, then retries and returns to event-only mode', async (failure) => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (failure === 'load') vi.mocked(loadNativeClientLogEvents).mockImplementation(() => { throw new Error('missing addon'); });
  else vi.mocked(loadNativeClientLogEvents).mockReturnValue({ ...native, watch: () => { throw new Error('stream unavailable'); } });
  await start(); await writeFile(file(), line('fallback')); await poll();
  expect(log.totalsList()).toHaveLength(1);
  vi.mocked(loadNativeClientLogEvents).mockReturnValue(native);
  for (let n = 0; n < CLIENT_LOG_WATCH_RETRY_MS / CLIENT_LOG_POLL_MS; n++) await poll();
  expect(nativeHandles).toHaveLength(2);
  vi.mocked(readdir).mockClear();
  for (let n = 0; n < 2 * CLIENT_LOG_RECONCILE_MS / CLIENT_LOG_POLL_MS; n++) await poll();
  expect(readdir).not.toHaveBeenCalled();
});

it('retries a failed native recovery scan without requiring another event or a periodic sweep', async () => {
  vi.mocked(loadNativeClientLogEvents).mockReturnValue(native);
  await start(); await writeFile(file(), line('missed'));
  vi.mocked(readdir).mockRejectedValueOnce(new Error('temporarily unavailable'));
  const done = waitIdle();
  nativeRoot().emit(nativeRoot().dir, native.constants.UserDropped);
  await done;
  expect(progress.mock.calls.at(-1)?.[0].error).toContain('temporarily unavailable');
  await poll();
  expect(log.totalsList()).toHaveLength(1);
  expect(progress.mock.calls.at(-1)?.[0].error).toBeNull();
});
