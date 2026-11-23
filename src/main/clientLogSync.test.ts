import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, open, stat, utimes } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { clientLogRoots, importClientFile, startClientLogSync, type ImportSink } from './clientLogSync';
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
      // Retaining the old file prevents inode reuse in this identity-only case.
      await rename(file, path.join(dir, 'rotated.jsonl'));
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

it('restarts on changed ctime even when file identity, birthtime, mtime and anchor are unchanged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-reused-inode-'));
  const file = path.join(dir, 'log.jsonl');
  const NS_PER_SECOND = 1_000_000_000n;
  let state: string | undefined;
  const sink: ImportSink = { checkpoint: () => state, importBatch: (_, s) => { state = s; } };
  try {
    await writeFile(file, '{}\n{}\n');
    await importClientFile(file, 'claude', sink);
    const raw = await stat(file, { bigint: true });
    vi.mocked(stat).mockResolvedValueOnce({ ...raw, isFile: () => true, isDirectory: () => false,
      ctimeNs: raw.ctimeNs + NS_PER_SECOND } as never);
    vi.mocked(open).mockClear();
    vi.mocked(parseClientLine).mockClear();
    await importClientFile(file, 'claude', sink);
    expect(open).toHaveBeenCalledTimes(1);
    expect(parseClientLine).toHaveBeenCalledTimes(2);
    expect(JSON.parse(state!)).toMatchObject({ offset: 6, complete: true });
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
  vi.stubEnv('T3_USERDATA_DIR', path.join(dir, 't3'));
  vi.stubEnv('GEMINI_HOME', path.join(dir, 'gemini'));
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

it('resolves the Antigravity ACP root from T3 userdata, T3 home, or the default home', () => {
  const home = path.join(tmpdir(), 't3-home');
  const userdata = path.join(tmpdir(), 't3-userdata');
  const acpRoot = () => clientLogRoots().filter(({ provider }) => provider === 'antigravity').map(({ dir }) => dir);
  const providerPath = ['providers', 'antigravity'];
  vi.stubEnv('T3CODE_HOME', home);
  vi.stubEnv('T3_USERDATA_DIR', userdata);
  try {
    expect(acpRoot()).toContain(path.join(userdata, ...providerPath));
    expect(acpRoot()).not.toContain(path.join(home, 'userdata', ...providerPath));
    vi.stubEnv('T3_USERDATA_DIR', undefined);
    expect(acpRoot()).toContain(path.join(home, 'userdata', ...providerPath));
    vi.stubEnv('T3CODE_HOME', undefined);
    expect(acpRoot()).toContain(path.join(homedir(), '.t3', 'userdata', ...providerPath));
  } finally { vi.unstubAllEnvs(); }
});

it('discovers Antigravity transcripts across ACP and CLI roots, checkpoints appends, and ignores full/chunk duplicates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-ag-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'claude'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('T3_USERDATA_DIR', path.join(dir, 't3'));
  vi.stubEnv('GEMINI_HOME', path.join(dir, 'gemini'));
  const acpLogs = path.join(dir, 't3', 'providers', 'antigravity', 'acct', 'antigravity-acp', 'brain', 'conv-acp', '.system_generated', 'logs');
  const cliLogs = path.join(dir, 'gemini', 'antigravity-cli', 'brain', 'conv-cli', '.system_generated', 'logs');
  const step = (idx: number, at: string) => JSON.stringify({
    step_index: idx, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at,
    model: 'gemini-4-neon-medium', input_tokens: 100, cache_read_tokens: 400, output_tokens: 25,
  }) + '\n';
  const states = new Map<string, string>();
  const records = new Map<string, ActivityEvent>();
  const sink: ImportSink = {
    checkpoint: (f) => states.get(f),
    importBatch: (f, s, events) => { states.set(f, s); for (const e of events) records.set(e.requestId, e); },
  };
  try {
    await mkdir(path.join(acpLogs, 'chunks', 'transcript'), { recursive: true });
    await mkdir(cliLogs, { recursive: true });
    const acpFile = path.join(acpLogs, 'transcript.jsonl');
    const cliFile = path.join(cliLogs, 'transcript.jsonl');
    await writeFile(acpFile, step(1, '2026-11-22T10:00:00Z'));
    // Duplicate sibling files must be ignored by the scanner.
    await writeFile(path.join(acpLogs, 'transcript_full.jsonl'), step(1, '2026-11-22T10:00:00Z'));
    await writeFile(path.join(acpLogs, 'chunks', 'transcript', '00000000.jsonl'), step(1, '2026-11-22T10:00:00Z'));
    await writeFile(cliFile, step(2, '2026-11-22T10:01:00Z'));
    await writeFile(path.join(dir, 't3', 'providers', 'antigravity', 'acct', 'antigravity-acp', 'antigravity-oauth-token'),
      JSON.stringify({ id_token_email: 'User@Example.com' }));
    sink.resolveAccount = (provider, email) => (provider === 'antigravity' && email.toLowerCase() === 'user@example.com' ? 'cred-ag-1' : null);
    let done!: () => void;
    const idle = new Promise<void>((resolve) => { done = resolve; });
    const progress = vi.fn((p) => { if (p.state === 'idle') done(); });
    const stop = startClientLogSync(sink, vi.fn(), progress);
    await idle; await stop();
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'idle', filesDone: 2, filesTotal: 2 });
    expect([...records.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'antigravity', client: 'antigravity-acp', sessionId: 'agy:conv-acp', model: 'gemini-4-neon', reasoningEffort: 'medium', authIndex: 'cred-ag-1', inputTokens: 500, cachedTokens: 400, outputTokens: 25 }),
      expect.objectContaining({ provider: 'antigravity', client: 'antigravity-cli', sessionId: 'agy:conv-cli', model: 'gemini-4-neon', reasoningEffort: 'medium', authIndex: null, inputTokens: 500, cachedTokens: 400, outputTokens: 25 }),
    ]));
    // Resumes from checkpoint on append without re-reading earlier lines.
    await appendFile(acpFile, step(3, '2026-11-22T10:02:00Z'));
    expect(await importClientFile(acpFile, 'antigravity', sink)).toBe(true);
    expect(records.size).toBe(3);
    expect(await importClientFile(acpFile, 'antigravity', sink)).toBe(false);
  } finally { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
});

it('resolves Antigravity authIndex at batch commit when the account map arrives or changes mid-scan', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-ag-late-map-'));
  const agRoot = path.join(dir, 'antigravity-acp');
  const logDir = path.join(agRoot, 'brain', 'conv-late', '.system_generated', 'logs');
  const file = path.join(logDir, 'transcript.jsonl');
  let state: string | undefined;
  let calls = 0;
  const committed: ActivityEvent[] = [];
  const sink: ImportSink = {
    checkpoint: () => state,
    // First call during file open returns an old mapping; commit-time lookup returns the replacement mapping.
    resolveAccount: (_provider, email) => (email === 'late@example.com' ? (++calls >= 2 ? 'cred-new' : 'cred-old') : null),
    importBatch: (_, s, events) => { state = s; committed.push(...events); },
  };
  try {
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(agRoot, 'antigravity-oauth-token'), JSON.stringify({ id_token_email: 'late@example.com' }));
    await writeFile(file, JSON.stringify({
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
      created_at: '2026-11-22T10:00:00Z', model: 'gemini-4-neon-high',
      input_tokens: 100, cache_read_tokens: 0, output_tokens: 10,
    }) + '\n');
    expect(await importClientFile(file, 'antigravity', sink)).toBe(true);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.authIndex).toBe('cred-new');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
