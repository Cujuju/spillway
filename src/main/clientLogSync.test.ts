import { mkdtemp, mkdir, writeFile, appendFile, rm, open, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { importClientFile, startClientLogSync, type ImportSink } from './clientLogSync';
import type { ActivityEvent } from '@shared/types';
import { createZstdDecompress, zstdCompressSync } from 'node:zlib';
import { parseClientLine } from './clientLogParser';

vi.mock('node:fs/promises', { spy: true });
vi.mock('node:zlib', { spy: true });
vi.mock('./clientLogParser', { spy: true });

it('resumes complete UTF-8 lines, checkpoints context, tolerates truncation and deletion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-sync-'));
  const file = path.join(dir, 'session.jsonl');
  const states = new Map<string, string>();
  const records = new Map<string, ActivityEvent>();
  const sink: ImportSink = { checkpoint: (f) => states.get(f), importBatch: (f, s, events) => {
    states.set(f, s); for (const e of events) records.set(e.requestId, e);
  } };
  const line = JSON.stringify({ timestamp: '2026-10-29', type: 'assistant', sessionId: 's', message: {
    id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: 'é',
  } });
  try {
    await writeFile(file, line);
    expect(await importClientFile(file, 'claude', sink)).toBe(false);
    await appendFile(file, '\n');
    expect(await importClientFile(file, 'claude', sink)).toBe(true);
    expect(records.size).toBe(1);
    expect(await importClientFile(file, 'claude', sink)).toBe(false);
    await appendFile(file, line.replace('msg_1', 'msg_2') + '\n{');
    await importClientFile(file, 'claude', sink);
    expect(records.size).toBe(2);
    await writeFile(file, line + '\n');
    await importClientFile(file, 'claude', sink);
    expect(records.size).toBe(2);
    await writeFile(file, line.replace('msg_1', 'msg_3') + '\n' + line.replace('msg_1', 'msg_4') + '\n');
    await importClientFile(file, 'claude', sink);
    expect(records.size).toBe(4);
    await rm(file);
    expect(await importClientFile(file, 'claude', sink)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([false, true])('does not open or decompress a completed unchanged file (archive: %s)', async (archive) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-unchanged-'));
  const file = path.join(dir, archive ? 'log.jsonl.zst' : 'log.jsonl');
  let state: string | undefined;
  const sink: ImportSink = { checkpoint: () => state, importBatch: (_, s) => { state = s; } };
  try {
    await writeFile(file, archive ? zstdCompressSync('{}\n{') : '{}\n{');
    await importClientFile(file, 'claude', sink);
    vi.mocked(open).mockClear();
    vi.mocked(parseClientLine).mockClear();
    vi.mocked(createZstdDecompress).mockClear();
    expect(await importClientFile(file, 'claude', sink)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(createZstdDecompress).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(['truncate', 'replace', 'backwards'])('restarts after %s even with a valid old anchor', async (mode) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-rotate-'));
  const file = path.join(dir, 'log.jsonl');
  let state: string | undefined;
  const sink: ImportSink = { checkpoint: () => state, importBatch: (_, s) => { state = s; } };
  try {
    await writeFile(file, '{}\n{}\n');
    await utimes(file, 1_700_000_000, 1_700_000_000);
    await importClientFile(file, 'claude', sink);
    if (mode === 'truncate') await writeFile(file, '{}\n');
    else if (mode === 'replace') {
      const info = await stat(file);
      await rm(file);
      await writeFile(file, '{}\n{}\n');
      await utimes(file, info.atimeMs / 1000, info.mtimeMs / 1000);
      expect((await stat(file)).mtimeMs).toBe(info.mtimeMs);
      expect((await stat(file)).size).toBe(info.size);
      const replacement = await stat(file, { bigint: true });
      const cp = JSON.parse(state!);
      expect([replacement.dev.toString(), replacement.ino.toString()]).not.toEqual([cp.dev, cp.ino]);
      // Simulate Windows birthtime tunnelling and a coincident ctime; only file identity can invalidate this checkpoint.
      cp.birthtime = Number(replacement.birthtimeNs) / 1e6;
      cp.ctime = Number(replacement.ctimeNs) / 1e6;
      state = JSON.stringify(cp);
    } else {
      await appendFile(file, '{}\n');
      const info = await stat(file);
      await utimes(file, info.atime, new Date(JSON.parse(state!).mtime - 10_000));
    }
    vi.mocked(open).mockClear();
    const batch = vi.spyOn(sink, 'importBatch');
    vi.mocked(parseClientLine).mockClear();
    await importClientFile(file, 'claude', sink);
    expect(open).toHaveBeenCalled();
    expect(JSON.parse(batch.mock.calls[0]![1]).offset).toBe(mode === 'backwards' ? 9 : mode === 'truncate' ? 3 : 6);
    expect(parseClientLine).toHaveBeenCalledTimes(mode === 'backwards' ? 3 : mode === 'truncate' ? 1 : 2);
    // A restart parses every line, even when the old anchor is still present.
    expect(JSON.parse(state!).complete).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('defers appends made after stat to the next scan', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-append-'));
  const file = path.join(dir, 'log.jsonl');
  let state: string | undefined;
  let appended = false;
  const sink: ImportSink = { checkpoint: () => state, importBatch: (_, s) => { state = s; } };
  try {
    await writeFile(file, '{}\n');
    const realStat = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(stat).mockImplementationOnce(async (...args: Parameters<typeof stat>) => {
      const info = await realStat.stat(...args);
      await appendFile(file, '{}\n'); appended = true;
      return info;
    });
    await importClientFile(file, 'claude', sink);
    expect(appended).toBe(true);
    expect(JSON.parse(state!).offset).toBe(3);
    await importClientFile(file, 'claude', sink);
    expect(JSON.parse(state!).offset).toBe(6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('polls without resets when unchanged or when accounting skips duplicate records', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-poll-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  const file = path.join(dir, 'projects', 'log.jsonl');
  let state: string | undefined;
  const changed = vi.fn();
  const sink: ImportSink = { checkpoint: () => state, importBatch: (_, s) => { state = s; return false; } };
  const line = JSON.stringify({ type: 'assistant', timestamp: '2026-10-30', sessionId: 's', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 1 } } }) + '\n';
  try {
    await mkdir(path.dirname(file));
    await writeFile(file, line);
    for (let poll = 0; poll < 2; poll++) {
      let done!: () => void;
      const idle = new Promise<void>((resolve) => { done = resolve; });
      const progress = vi.fn((p) => { if (p.state === 'idle') done(); });
      const stop = startClientLogSync(sink, changed, progress);
      await idle; await stop();
      expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'idle', filesDone: 1, filesTotal: 1 });
    }
    expect(changed).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
});

it.each([false, true])('resumes an interrupted scan of an unchanged file (archive: %s)', async (archived) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-resume-'));
  const file = path.join(dir, archived ? 'session.jsonl.zst' : 'session.jsonl');
  let state: string | undefined;
  let stopped = false;
  const records = new Map<string, ActivityEvent>();
  const sink: ImportSink = { checkpoint: () => state, importBatch: (_, s, events) => {
    state = s;
    for (const e of events) records.set(e.requestId, e);
    if (events.length) stopped = true;
  } };
  const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ type: 'assistant', sessionId: 's',
    timestamp: '2026-10-29', message: { id: `msg_${i}`, model: 'claude-opus-5-5', usage: { input_tokens: 1 } } })).join('\n') + '\n';
  try {
    await writeFile(file, archived ? zstdCompressSync(lines) : lines);
    await importClientFile(file, 'claude', sink, () => stopped);
    expect(records.size).toBeGreaterThan(0);
    expect(records.size).toBeLessThan(1000);
    await importClientFile(file, 'claude', sink);
    expect(records.size).toBe(1000);
    expect(await importClientFile(file, 'claude', sink)).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('adopts 100 unchanged legacy identities without opening files; rereads changed files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-upgrade-'));
  const states = new Map<string, string>();
  const sink: ImportSink = { checkpoint: (f) => states.get(f), importBatch: (f, s) => { states.set(f, s); } };
  try {
    const files = Array.from({ length: 100 }, (_, n) => path.join(dir, `${n}.jsonl`));
    for (const file of files) {
      await writeFile(file, '{}\n'); await importClientFile(file, 'claude', sink);
    }
    // Legacy checkpoints stored fs.Stats millisecond times from a non-bigint stat().
    for (const [n, file] of files.entries()) {
      const key = [...states.keys()][n]!;
      const cp = JSON.parse(states.get(key)!);
      const legacy = await stat(file);
      delete cp.version; delete cp.dev; delete cp.ino; delete cp.ctime;
      states.set(key, JSON.stringify({ ...cp, mtime: legacy.mtimeMs, birthtime: legacy.birthtimeMs }));
    }
    vi.mocked(open).mockClear();
    for (const file of files) await importClientFile(file, 'claude', sink);
    expect([...states.values()].every((s) => JSON.parse(s).version === 2)).toBe(true);
    expect(open).not.toHaveBeenCalled();
    const cp = JSON.parse(states.values().next().value!); delete cp.version;
    states.set([...states.keys()][0]!, JSON.stringify(cp));
    await appendFile(files[0]!, '{}\n'); await importClientFile(files[0]!, 'claude', sink);
    expect(open).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(['zero', 'large'])('compares %s filesystem identities without false replacement or precision loss', async (mode) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-identity-'));
  let state: string | undefined;
  const sink: ImportSink = { checkpoint: () => state, importBatch: (_, s) => { state = s; } };
  try {
    const file = path.join(dir, 'log.jsonl'); await writeFile(file, '{}\n');
    const raw = await stat(file, { bigint: true });
    const info = { ...raw, isFile: () => true, isDirectory: () => false, dev: mode === 'zero' ? 0n : 1n, ino: mode === 'zero' ? 0n : 9007199254740992n };
    vi.mocked(stat).mockResolvedValueOnce(info as never);
    await importClientFile(file, 'claude', sink);
    const cp = JSON.parse(state!);
    if (mode === 'zero') { cp.dev = '1'; cp.ino = '123'; state = JSON.stringify(cp); }
    vi.mocked(open).mockClear(); vi.mocked(parseClientLine).mockClear();
    vi.mocked(stat).mockResolvedValueOnce({ ...info, ino: mode === 'zero' ? 0n : 9007199254740993n } as never);
    await importClientFile(file, 'claude', sink);
    expect(open).toHaveBeenCalledTimes(mode === 'zero' ? 0 : 1);
    expect(parseClientLine).toHaveBeenCalledTimes(mode === 'zero' ? 0 : 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
