import { createHash } from 'node:crypto';
import { opendir, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { parseClientLine, type LogContext } from './clientLogParser';
import type { ActivityEvent } from '@shared/types';

/** Polling also discovers newly created directories and avoids recursive fs.watch differences on Windows/macOS. */
export const CLIENT_LOG_POLL_MS = 30_000;
const CHECKPOINT_ANCHOR_BYTES = 256;
const READ_CHUNK_BYTES = 256 * 1024;
export interface Checkpoint { size: number; mtime: number; offset: number; context: LogContext; birthtime: number; anchor: string }
export interface ImportSink {
  checkpoint(file: string): string | undefined;
  importBatch(file: string, state: string, events: ActivityEvent[]): void;
}
export const clientLogRoots = () => [
  { provider: 'claude' as const, dir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects') },
  { provider: 'codex' as const, dir: path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions') },
];
const missing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

async function* files(dir: string): AsyncGenerator<string> {
  try {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* files(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file;
    }
  } catch (e) { if (!missing(e)) throw e; }
}

/** Checkpoints only complete lines. Partial UTF-8 characters and partial JSON remain unread until the next scan. */
export async function importClientFile(file: string, provider: 'claude' | 'codex', sink: ImportSink, stopped = () => false): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(file);
    const saved = sink.checkpoint(file);
    let cp: Checkpoint | undefined = saved ? JSON.parse(saved) : undefined;
    if (cp && (info.size < cp.size || info.birthtimeMs !== cp.birthtime || (info.size === cp.size && info.mtimeMs !== cp.mtime))) cp = undefined;
    if (cp?.size === info.size && cp.mtime === info.mtimeMs) return false;
    handle = await open(file, 'r');
    const anchorAt = async (offset: number): Promise<string> => {
      const buffer = Buffer.alloc(Math.min(CHECKPOINT_ANCHOR_BYTES, offset));
      await handle!.read(buffer, 0, buffer.length, offset - buffer.length);
      return createHash('sha256').update(buffer).digest('hex');
    };
    if (cp && cp.anchor !== await anchorAt(cp.offset)) cp = undefined;
    const context = cp?.context ?? {};
    let offset = cp?.offset ?? 0;
    let position = offset;
    let pending = Buffer.alloc(0);
    let changed = false;
    while (position < info.size && !stopped()) {
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, info.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead || stopped()) break;
      position += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      const end = pending.lastIndexOf(10);
      if (end >= 0) {
        const events: ActivityEvent[] = [];
        for (const line of pending.subarray(0, end).toString('utf8').split('\n')) {
          const e = parseClientLine(line, provider, context);
          if (e) events.push(e);
        }
        offset += end + 1;
        pending = pending.subarray(end + 1);
        const state: Checkpoint = { size: info.size, mtime: info.mtimeMs, offset, context, birthtime: info.birthtimeMs, anchor: await anchorAt(offset) };
        if (stopped()) break;
        sink.importBatch(file, JSON.stringify(state), events);
        changed ||= events.length > 0;
      }
      await setImmediate();
    }
    return changed;
  } catch (e) { if (!missing(e)) throw e; return false; }
  finally { await handle?.close(); }
}

export function startClientLogSync(sink: ImportSink, changed: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const scan = async () => {
    let dirty = false;
    for (const root of clientLogRoots()) {
      try {
        for await (const file of files(root.dir)) {
          if (stopped) return;
          try { dirty = await importClientFile(file, root.provider, sink, () => stopped) || dirty; }
          catch (e) { console.error('[activity] client log import failed:', file, e); }
        }
      } catch (e) { console.error('[activity] client log scan failed:', e); }
    }
    if (dirty && !stopped) changed();
    if (!stopped) timer = setTimeout(() => void scan(), CLIENT_LOG_POLL_MS);
  };
  void scan();
  return () => { stopped = true; clearTimeout(timer); };
}
