import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Parent watches detect root replacement; missing ancestors are advanced on each reconciliation. */
export class ClientLogWatcher {
  private handles: FSWatcher[] = [];
  private closed = false;
  private logged = false;
  fallback = false;

  constructor(readonly dir: string, private dirty: (file: string) => void, private reconcile: () => void) {}

  async refresh(): Promise<void> {
    this.closeHandles();
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
      this.add(watch(parent, (event, filename) => {
        if (filename === null || (event === 'rename' && filename.toString() === path.basename(target))) this.reconcile();
      }));
      try {
        this.add(watch(this.dir, { recursive: true }, (event, filename) => {
          if (filename === null || filename.toString() === path.basename(this.dir)) { this.reconcile(); return; }
          const file = path.resolve(this.dir, filename.toString());
          if (/\.jsonl(?:\.zst)?$/.test(file)) this.dirty(file);
          // Directory renames may introduce populated subtrees without individual file events.
          else if (event === 'rename') this.reconcile();
        }));
      } catch (e) {
        if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
      this.fallback = false;
    } catch (e) { this.fail(e); }
  }

  private add(handle: FSWatcher): void {
    this.handles.push(handle);
    handle.on('error', (e) => { this.fail(e); this.reconcile(); });
  }

  private fail(e: unknown): void {
    this.closeHandles(); this.fallback = true;
    if (!this.logged) {
      console.warn('[activity] Client log watcher unavailable; polling every 30 seconds:', this.dir, e);
      this.logged = true;
    }
  }

  private closeHandles(): void { for (const handle of this.handles) handle.close(); this.handles = []; }
  close(): void { this.closed = true; this.closeHandles(); }
}
