import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { readdir, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { ClientLogWatcher } from './clientLogWatcher';
import { clientLogKey, isClientLogFile } from './clientLogPaths';
import { parseClientLine, type LogContext } from './clientLogParser';
import type { ActivityEvent } from '@shared/types';

/** Batch streaming appends at the existing cadence. */
export const CLIENT_LOG_POLL_MS = 30_000;
/** Safety net for watchers that hide dropped events (Node on macOS without fsevents). */
export const CLIENT_LOG_RECONCILE_MS = 5 * 60_000;
/** Bound renderer progress traffic during large individual files. */
const IMPORT_PROGRESS_INTERVAL_MS = 100;
const CHECKPOINT_ANCHOR_BYTES = 256;
const READ_CHUNK_BYTES = 256 * 1024;
/** Small usage-only lines must not turn a byte-sized read into an unbounded synchronous transaction. */
const MAX_BATCH_LINES = 128;
/** Identity-aware checkpoints; unchanged legacy files adopt identity without replay. */
const CHECKPOINT_VERSION = 2;
export interface Checkpoint { size: number; mtime: number; offset: number; context: LogContext; birthtime: number; dev: string; ino: string; ctime: number; anchor: string; complete?: boolean; version?: number }
export interface ImportSink {
  checkpoint(file: string): string | undefined;
  /** False means only the checkpoint changed; void preserves sinks without accounting feedback. */
  importBatch(file: string, state: string, events: ActivityEvent[]): boolean | void;
}
export const clientLogRoots = () => [
  { provider: 'claude' as const, dir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects') },
  { provider: 'codex' as const, dir: path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions') },
];
const missing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');
const NS_PER_SEC = 1_000_000_000n;
const MS_PER_SEC = 1000;
const NS_PER_MS = 1_000_000;
/** Same arithmetic as fs.Stats `*Ms`, which legacy checkpoints stored; a plain ns/1e6 rounds differently. */
const statMs = (ns: bigint) => Number(ns / NS_PER_SEC) * MS_PER_SEC + Number(ns % NS_PER_SEC) / NS_PER_MS;
async function isDirectory(file: string): Promise<boolean> {
  try { return (await stat(file)).isDirectory(); } catch (e) { if (missing(e)) return false; throw e; }
}

async function* files(dir: string): AsyncGenerator<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* files(file);
      else if (entry.isFile() && isClientLogFile(entry.name)) yield file;
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
export async function importClientFile(file: string, provider: 'claude' | 'codex', sink: ImportSink, stopped = () => false): Promise<boolean | 'directory'> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const raw = await stat(file, { bigint: true });
    if (raw.isDirectory()) return 'directory';
    if (!raw.isFile()) return false;
    const key = clientLogKey(file);
    const info = { size: Number(raw.size), mtimeMs: statMs(raw.mtimeNs), birthtimeMs: statMs(raw.birthtimeNs), ctimeMs: statMs(raw.ctimeNs) };
    const identity = { dev: raw.dev.toString(), ino: raw.ino.toString(), ctime: info.ctimeMs };
    const saved = sink.checkpoint(key);
    const archived = file.endsWith('.zst');
    let cp: Checkpoint | undefined = saved ? JSON.parse(saved) : undefined;
    if (cp && cp.version !== CHECKPOINT_VERSION) {
      if (cp.size === info.size && cp.mtime === info.mtimeMs) {
        cp = { ...cp, version: CHECKPOINT_VERSION, birthtime: info.birthtimeMs, ...identity };
        sink.importBatch(key, JSON.stringify(cp), []);
      } else cp = undefined;
    }
    // Some network filesystems expose no stable identity. Metadata and anchors remain authoritative there.
    const hasIdentity = (dev: string, ino: string) => !!dev && !!ino && dev !== '0' && ino !== '0';
    const replaced = cp && hasIdentity(cp.dev, cp.ino) && hasIdentity(identity.dev, identity.ino)
      && (cp.dev !== identity.dev || cp.ino !== identity.ino);
    if (cp && (replaced || (cp.ctime !== info.ctimeMs && cp.size === info.size) || info.size < cp.size || info.mtimeMs < cp.mtime || info.birthtimeMs !== cp.birthtime || (info.mtimeMs !== cp.mtime && (archived || info.size === cp.size)))) cp = undefined;
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
          const state: Checkpoint = { version: CHECKPOINT_VERSION, size: info.size, mtime: info.mtimeMs, offset, context, birthtime: info.birthtimeMs, ...identity, anchor: archived ? '' : await anchorAt(offset) };
          if (stopped()) break;
          const committed = sink.importBatch(key, JSON.stringify(state), events);
          changed = (events.length > 0 && committed !== false) || changed;
          await setImmediate();
          end = pending.lastIndexOf(10);
        }
      }
      await setImmediate();
    }
    if (!stopped()) sink.importBatch(key, JSON.stringify({ version: CHECKPOINT_VERSION, size: info.size, mtime: info.mtimeMs, offset, context,
      birthtime: info.birthtimeMs, ...identity, anchor: archived ? '' : await anchorAt(offset), complete: true } satisfies Checkpoint), []);
    return changed;
  } catch (e) { if (!missing(e)) throw e; return false; }
  finally { await handle?.close(); }
}

export function startClientLogSync(sink: ImportSink, changed: () => void, progress: (p: import('@shared/ipc').ActivityImportState) => void = () => {}): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let running: Promise<void>;
  let reconcile = true;
  let lastReconcile = 0;
  let active = false;
  const roots = clientLogRoots().map((root) => {
    const dirty = new Map<string, string>();
    return { ...root, dirty, watcher: new ClientLogWatcher(root.dir, (file) => dirty.set(clientLogKey(file), file), requestReconcile) };
  });
  function requestReconcile() {
    if (stopped) return;
    reconcile = true;
    if (!active) { clearTimeout(timer); running = scan(); }
  }
  const scan = async () => {
    active = true;
    let dirty = false;
    const state: import('@shared/ipc').ActivityImportState = { state: 'importing', filesDone: 0, filesTotal: 0, recordsImported: 0, error: null };
    const pending: { file: string; provider: 'claude' | 'codex' }[] = [];
    let lastProgress = 0;
    const reportProgress = () => {
      if (Date.now() - lastProgress < IMPORT_PROGRESS_INTERVAL_MS) return;
      progress({ ...state });
      lastProgress = Date.now();
    };
    const counted: ImportSink = {
      checkpoint: (file) => sink.checkpoint(file),
      importBatch: (file, checkpoint, events) => {
        const committed = sink.importBatch(file, checkpoint, events);
        dirty = (events.length > 0 && committed !== false) || dirty;
        state.recordsImported += events.length;
        reportProgress();
        return committed;
      },
    };
    reportProgress();
    try {
      const full = reconcile || (roots.some((root) => root.watcher.needsPeriodicReconcile) && Date.now() - lastReconcile >= CLIENT_LOG_RECONCILE_MS);
      reconcile = false;
      if (full) lastReconcile = Date.now();
      for (const root of roots) {
        // Swap the work set before awaiting: events during this scan belong to the next poll.
        const dirtyFiles = [...root.dirty.values()];
        root.dirty.clear();
        const polling = root.watcher.fallback;
        if (full || polling) await root.watcher.refresh();
        if (full || polling || root.watcher.fallback) {
          for await (const file of files(root.dir)) {
            if (stopped) return;
            pending.push({ file, provider: root.provider });
          }
        } else for (const file of dirtyFiles) {
          if (isClientLogFile(file)) pending.push({ file, provider: root.provider });
          // Renames can introduce populated directories; only a walk finds their children.
          else if (await isDirectory(file)) reconcile = true;
        }
      }
      state.filesTotal = pending.length;
      reportProgress();
      for (const { file, provider } of pending) {
        if (stopped) return;
        try {
          const result = await importClientFile(file, provider, counted, () => stopped);
          if (result === 'directory') reconcile = true;
          else dirty = result || dirty;
        }
        catch (e) { roots.find((root) => root.provider === provider)!.dirty.set(clientLogKey(file), file); state.error = `Local usage import failed: ${String(e)}`; console.error('[activity]', file, e); }
        state.filesDone++;
        reportProgress();
      }
      if (dirty && !stopped) changed();
    } catch (e) { reconcile = true; state.error = `Local usage scan failed: ${String(e)}`; }
    finally {
      progress({ ...state, state: 'idle' });
      active = false;
      if (!stopped) timer = setTimeout(() => { running = scan(); }, reconcile && !state.error ? 0 : CLIENT_LOG_POLL_MS);
    }
  };
  running = scan();
  return async () => { stopped = true; clearTimeout(timer); await Promise.all(roots.map((root) => root.watcher.close())); await running; };
}
