import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { importClientFile, type ImportSink } from './clientLogSync';
import type { ActivityEvent } from '@shared/types';

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
