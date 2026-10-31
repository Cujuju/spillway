import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isClientLogFile } from './clientLogPaths';
import { loadNativeClientLogEvents, watchNativeClientLogs } from './nativeClientLogWatcher';

/** Retry once per reconciliation window; persistent OS failures must not turn polling into a scan loop. */
export const CLIENT_LOG_WATCH_RETRY_MS = 5 * 60_000;

/** Parent watches detect root replacement; missing ancestors are advanced on each reconciliation. */
export class ClientLogWatcher {
  private handles: FSWatcher[] = [];
  private closed = false;
  private logged = false;
  fallback = false;
  private retryAt = 0;
  private reconciledFailure = false;
  private nativeStop: (() => Promise<void>) | undefined;
  private closing: Promise<void> = Promise.resolve();
  private generation = 0;

  /** Windows' Node watcher reports overflow as a null filename; elsewhere Node hides drops, so only native streams skip timed scans. */
  get needsPeriodicReconcile(): boolean { return !this.nativeStop && process.platform !== 'win32'; }

  constructor(readonly dir: string, private dirty: (file: string) => void, private reconcile: () => void) {}

  async refresh(): Promise<void> {
    if (this.closed || (this.fallback && Date.now() < this.retryAt)) return;
    await this.closeHandles();
    if (this.closed) return;
    const generation = this.generation;
    let parent = path.dirname(this.dir);
    let target = this.dir;
    try {
      while (true) {
        try { await stat(parent); break; }
        catch (e) {
          if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '') || parent === path.dirname(parent)) throw e;
          target = parent; parent = path.dirname(parent);
        }
      }
      if (this.closed) return;
      const native = loadNativeClientLogEvents();
      if (native) {
        const stop = await watchNativeClientLogs(native, parent, this.dir,
          (file) => { if (!this.closed && generation === this.generation) this.dirty(file); },
          () => { if (!this.closed && generation === this.generation) this.reconcile(); });
        if (this.closed || generation !== this.generation) { await stop(); return; }
        this.nativeStop = stop;
        this.fallback = false;
        return;
      }
      this.add(watch(parent, (event, filename) => {
        if (filename === null || (event === 'rename' && filename.toString() === path.basename(target))) this.reconcile();
      }));
      try {
        this.add(watch(this.dir, { recursive: true }, (event, filename) => {
          if (filename === null || filename.toString() === path.basename(this.dir)) { this.reconcile(); return; }
          const file = path.resolve(this.dir, filename.toString());
          // A rename may be a new file or a populated directory; the poll stats it to tell.
          if (event === 'rename' || isClientLogFile(file)) this.dirty(file);
        }));
      } catch (e) {
        if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
      this.fallback = false;
    } catch (e) { this.fail(e); }
  }

  private add(handle: FSWatcher): void {
    this.handles.push(handle);
    handle.on('error', (e) => {
      if (this.closed || !this.handles.includes(handle)) return;
      this.fail(e);
      if (!this.reconciledFailure) { this.reconciledFailure = true; this.reconcile(); }
    });
  }

  private fail(e: unknown): void {
    void this.closeHandles(); this.fallback = true;
    this.retryAt = Date.now() + CLIENT_LOG_WATCH_RETRY_MS;
    if (!this.logged) {
      console.warn('[activity] Client log watcher unavailable; polling every 30 seconds:', this.dir, e);
      this.logged = true;
    }
  }

  private closeHandles(): Promise<void> {
    this.generation++;
    for (const handle of this.handles) handle.close();
    this.handles = [];
    const stop = this.nativeStop;
    this.nativeStop = undefined;
    if (stop) this.closing = this.closing.then(stop).catch((e: unknown) => console.warn('[activity] Client log watcher close failed:', e));
    return this.closing;
  }
  close(): Promise<void> { this.closed = true; return this.closeHandles(); }
}
