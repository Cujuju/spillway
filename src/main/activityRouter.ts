import { EventEmitter } from 'node:events';
import { ActivityRpc } from './activityRpc';
import { READ_ONLY_ACTIVITY_METHODS, type ActivityMethods, type EvalMethods, type Method } from './activityProtocol';

type AllMethods = ActivityMethods & EvalMethods;

/** Routes writes to the writer worker, SQLite reads to a WAL reader worker, and title scans to a dedicated worker. */
export class ActivityRouter extends EventEmitter {
  private reader: ActivityRpc | null = null;
  private readerReady = false;
  private clearing = 0;
  private closed = false;
  private namesStarted = false;

  constructor(
    private writer: ActivityRpc,
    private makeReader: () => ActivityRpc,
    private names: ActivityRpc,
  ) {
    super();
    this.names.on('failure', (error: unknown) => console.error('[activity:names]', error));
    for (const event of ['reset', 'progress', 'migration', 'failure'] as const) {
      this.writer.on(event, (value: unknown) => {
        if (event === 'reset' && !this.closed && this.clearing === 0) this.ensureReader();
        this.emit(event, value);
      });
    }
  }

  get unacknowledgedEvents(): number { return this.writer.unacknowledgedEvents; }

  start(): void {
    this.writer.start();
    if (!this.namesStarted) {
      this.namesStarted = true;
      this.names.start();
    }
  }

  private ensureReader(): void {
    if (this.readerReady || this.closed || this.clearing > 0) return;
    const reader = this.makeReader();
    reader.on('failure', (error: unknown) => console.error('[activity:read]', error));
    this.reader = reader;
    reader.start();
    this.readerReady = true;
  }

  async call<K extends Method>(method: K, ...args: Parameters<AllMethods[K]>): Promise<Awaited<ReturnType<AllMethods[K]>>> {
    if (method === 'names') {
      if (!this.namesStarted && !this.closed) { this.namesStarted = true; this.names.start(); }
      return this.names.call(method, ...args);
    }
    if (method === 'clear') {
      this.clearing += 1;
      this.readerReady = false;
      const oldReader = this.reader;
      this.reader = null;
      if (oldReader) await oldReader.close().catch(() => oldReader.cancel());
      try { return await this.writer.call(method, ...args); }
      finally {
        this.clearing -= 1;
        if (!this.closed && this.clearing === 0) this.ensureReader();
      }
    }
    if (READ_ONLY_ACTIVITY_METHODS.has(method) && this.readerReady && this.reader && this.clearing === 0 && !this.closed) {
      return this.reader.call(method, ...args);
    }
    return this.writer.call(method, ...args);
  }

  cancel(): void {
    this.closed = true;
    this.readerReady = false;
    this.reader?.cancel();
    this.reader = null;
    this.names.cancel();
    this.writer.cancel();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.readerReady = false;
    const reader = this.reader;
    this.reader = null;
    await Promise.all([
      reader ? reader.close().catch(() => reader.cancel()) : Promise.resolve(),
      this.namesStarted ? this.names.close().catch(() => this.names.cancel()) : Promise.resolve(),
      this.writer.close(),
    ]);
  }

  async abandon(graceMs: number): Promise<void> {
    this.closed = true;
    this.readerReady = false;
    const reader = this.reader;
    this.reader = null;
    await Promise.all([
      reader ? reader.abandon(graceMs) : Promise.resolve(),
      this.namesStarted ? this.names.abandon(graceMs) : Promise.resolve(),
      this.writer.abandon(graceMs),
    ]);
  }
}
