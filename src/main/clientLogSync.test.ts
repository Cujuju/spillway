import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { importClientFile, type ImportSink } from './clientLogSync';
import type { ActivityEvent } from '@shared/types';
import { zstdCompressSync } from 'node:zlib';

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
