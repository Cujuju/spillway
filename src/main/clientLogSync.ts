import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { opendir, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { parseClientLine, type LogContext } from './clientLogParser';
import type { ActivityEvent } from '@shared/types';

/** Thirty-second polling bounds staleness without reacting to every streaming append, and discovers new directories consistently on Windows/macOS. */
export const CLIENT_LOG_POLL_MS = 30_000;
/** Bound renderer progress traffic during large individual files. */
const IMPORT_PROGRESS_INTERVAL_MS = 100;
const CHECKPOINT_ANCHOR_BYTES = 256;
const READ_CHUNK_BYTES = 256 * 1024;
/** Small usage-only lines must not turn a byte-sized read into an unbounded synchronous transaction. */
const MAX_BATCH_LINES = 128;
/** Replays unversioned checkpoints once to repair preliminary Claude usage already imported. */
const CHECKPOINT_VERSION = 1;
export interface Checkpoint { size: number; mtime: number; offset: number; context: LogContext; birthtime: number; anchor: string; complete?: boolean; version?: number }
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
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) yield file;
    }
  } catch (e) { if (!missing(e)) throw e; }
}

/** Archives resume at decompressed offsets; replaying compressed bytes never replays committed records. */
async function* archiveChunks(file: string, offset: number): AsyncGenerator<Buffer> {
  const input = createReadStream(file);
  const decoded = input.pipe(createZstdDecompress());
  input.on('error', (error) => decoded.destroy(error));
  try {
    for await (const chunk of decoded) {
      const buffer = chunk as Buffer;
      const skip = Math.min(offset, buffer.length);
      offset -= skip;
      if (skip < buffer.length) yield buffer.subarray(skip);
    }
  } finally { input.destroy(); decoded.destroy(); }
}

/** Checkpoints only complete lines. Partial UTF-8 characters and partial JSON remain unread until the next scan. */
export async function importClientFile(file: string, provider: 'claude' | 'codex', sink: ImportSink, stopped = () => false): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await stat(file);
    const saved = sink.checkpoint(file);
    const archived = file.endsWith('.zst');
    let cp: Checkpoint | undefined = saved ? JSON.parse(saved) : undefined;
    if (cp?.version !== CHECKPOINT_VERSION) cp = undefined;
    if (cp && (info.size < cp.size || info.birthtimeMs !== cp.birthtime || (info.mtimeMs !== cp.mtime && (archived || info.size === cp.size)))) cp = undefined;
    if (cp?.complete && cp.size === info.size && cp.mtime === info.mtimeMs) return false;
    handle = await open(file, 'r');
    const anchorAt = async (offset: number): Promise<string> => {
      const buffer = Buffer.alloc(Math.min(CHECKPOINT_ANCHOR_BYTES, offset));
      await handle!.read(buffer, 0, buffer.length, offset - buffer.length);
      return createHash('sha256').update(buffer).digest('hex');
    };
    if (cp && !archived && cp.anchor !== await anchorAt(cp.offset)) cp = undefined;
    const context = cp?.context ?? {};
    let offset = cp?.offset ?? 0;
    let position = offset;
    let pending = Buffer.alloc(0);
    let changed = false;
    async function* chunks(): AsyncGenerator<Buffer> {
      if (archived) { yield* archiveChunks(file, offset); return; }
      while (position < info.size && !stopped()) {
        const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, info.size - position));
        const { bytesRead } = await handle!.read(buffer, 0, buffer.length, position);
        if (!bytesRead) return;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    }
    for await (const buffer of chunks()) {
      if (stopped()) break;
      pending = Buffer.concat([pending, buffer]);
      let end = pending.lastIndexOf(10);
      if (end >= 0) {
        while (end >= 0 && !stopped()) {
          let boundary = -1;
          for (let n = 0; n < MAX_BATCH_LINES; n++) {
            const next = pending.indexOf(10, boundary + 1);
            if (next < 0) break;
            boundary = next;
          }
          end = boundary;
          const events: ActivityEvent[] = [];
          for (const line of pending.subarray(0, end).toString('utf8').split('\n')) {
            const e = parseClientLine(line, provider, context);
            if (e) events.push(e);
          }
          offset += end + 1;
          pending = pending.subarray(end + 1);
          const state: Checkpoint = { version: CHECKPOINT_VERSION, size: info.size, mtime: info.mtimeMs, offset, context, birthtime: info.birthtimeMs, anchor: archived ? '' : await anchorAt(offset) };
          if (stopped()) break;
          sink.importBatch(file, JSON.stringify(state), events);
          changed ||= events.length > 0;
          await setImmediate();
          end = pending.lastIndexOf(10);
        }
      }
      await setImmediate();
    }
    if (!stopped()) sink.importBatch(file, JSON.stringify({ version: CHECKPOINT_VERSION, size: info.size, mtime: info.mtimeMs, offset, context,
      birthtime: info.birthtimeMs, anchor: archived ? '' : await anchorAt(offset), complete: true } satisfies Checkpoint), []);
    return changed;
  } catch (e) { if (!missing(e)) throw e; return false; }
  finally { await handle?.close(); }
}

export function startClientLogSync(sink: ImportSink, changed: () => void, progress: (p: import('@shared/ipc').ActivityImportState) => void = () => {}): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let running: Promise<void>;
  const scan = async () => {
    let dirty = false;
    const state: import('@shared/ipc').ActivityImportState = { state: 'importing', filesDone: 0, filesTotal: 0, recordsImported: 0, error: null };
    const pending: { file: string; provider: 'claude' | 'codex' }[] = [];
    let lastProgress = 0;
    const counted: ImportSink = {
      checkpoint: (file) => sink.checkpoint(file),
      importBatch: (file, checkpoint, events) => {
        sink.importBatch(file, checkpoint, events);
        state.recordsImported += events.length;
        if (Date.now() - lastProgress >= IMPORT_PROGRESS_INTERVAL_MS) {
          progress({ ...state });
          lastProgress = Date.now();
        }
      },
    };
    progress({ ...state });
    try {
      for (const root of clientLogRoots()) for await (const file of files(root.dir)) {
        if (stopped) return;
        pending.push({ file, provider: root.provider });
      }
      state.filesTotal = pending.length;
      progress({ ...state });
      for (const { file, provider } of pending) {
        if (stopped) return;
        try { dirty = await importClientFile(file, provider, counted, () => stopped) || dirty; }
        catch (e) { state.error = `Local usage import failed: ${String(e)}`; console.error('[activity]', file, e); }
        state.filesDone++;
        progress({ ...state });
      }
      if (dirty && !stopped) changed();
    } catch (e) { state.error = `Local usage scan failed: ${String(e)}`; }
    finally {
      progress({ ...state, state: 'idle' });
      if (!stopped) timer = setTimeout(() => { running = scan(); }, CLIENT_LOG_POLL_MS);
    }
  };
  running = scan();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
