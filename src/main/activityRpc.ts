import { EventEmitter } from 'node:events';
import type { ActivityMethods, Method, Request, WorkerMessage } from './activityProtocol';
/** One second avoids a hot crash loop while keeping queued proxy events close to real time. */
export const ACTIVITY_RESTART_BACKOFF_MS = 1_000;
/** Assumption: 2,000 events/hour; retain two hours of worker outage in memory. */
export const ACTIVITY_QUEUE_CAP = 4_000;
export interface RpcPort extends EventEmitter { postMessage(message: Request): void; terminate?(): unknown }
interface Pending { request: Request; resolve(value: unknown): void; reject(error: Error): void }
/** Keeps unacknowledged requests in order across crashes; database mutations must be replay-safe. */
export class ActivityRpc extends EventEmitter {
  private port: RpcPort | null = null;
  private pending: Pending[] = [];
  private nextId = 0;
  private inFlight: Request | null = null;
  droppedEvents = 0;
  get unacknowledgedEvents(): number { return this.pending.filter((p) => p.request.method === 'append').length; }
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private closing = false;
  constructor(private factory: () => RpcPort) { super(); }
  start(): void {
    if (this.closed || this.port) return;
    try {
      const port = this.factory();
      this.port = port;
      port.on('message', (message: WorkerMessage) => {
        if (this.port !== port) return;
        if ('event' in message) {
          if (message.event === 'progress' && this.droppedEvents) message.value.error = this.dropNotice();
          this.emit(message.event, 'value' in message ? message.value : undefined);
          return;
        }
        if (message.id !== this.inFlight?.id) return;
        this.inFlight = null;
        const item = this.pending[0];
        if (!item || item.request.id !== message.id) { this.send(); return; }
        if (message.error !== undefined && item.request.method === 'append') {
          this.emit('failure', `Activity write failed; queued for retry: ${message.error}`);
          this.retry = setTimeout(() => this.send(), ACTIVITY_RESTART_BACKOFF_MS);
          return;
        }
        this.pending.shift();
        if (message.error !== undefined) item.reject(new Error(message.error));
        else item.resolve(message.value);
        if (item.request.method === 'close') { this.closed = true; this.port = null; }
        else this.send();
      });
      const failed = (error: unknown) => {
        if (this.port !== port) return;
        this.port = null;
        this.inFlight = null;
        clearTimeout(this.retry);
        this.emit('failure', `Activity worker stopped; retrying in ${ACTIVITY_RESTART_BACKOFF_MS} ms: ${String(error)}`);
        this.retry = setTimeout(() => this.start(), ACTIVITY_RESTART_BACKOFF_MS);
      };
      port.on('error', failed);
      port.on('exit', (code) => failed(`exit ${code}`));
      this.send();
    } catch (e) {
      this.emit('failure', String(e));
      this.retry = setTimeout(() => this.start(), ACTIVITY_RESTART_BACKOFF_MS);
    }
  }
  call<K extends Method>(method: K, ...args: Parameters<ActivityMethods[K]>): Promise<Awaited<ReturnType<ActivityMethods[K]>>> {
    if (this.closed || (this.closing && method !== 'close')) return Promise.reject(new Error('Activity worker closed'));
    return new Promise((resolve, reject) => {
      if (this.pending.length >= ACTIVITY_QUEUE_CAP && method !== 'close') {
        const index = this.pending.findIndex((p) => p.request.method === 'append');
        if (index < 0) { reject(new Error('Activity queue full')); return; }
        const [dropped] = this.pending.splice(index, 1);
        dropped!.reject(new Error('Activity queue overflow'));
        this.droppedEvents++;
        this.emit('failure', this.dropNotice());
        if (index === 0) { clearTimeout(this.retry); this.send(); }
      }
      this.pending.push({ request: { id: ++this.nextId, method, args } as Request, resolve: resolve as (value: unknown) => void, reject });
      if (this.pending.length === 1) this.send();
    });
  }
  private dropNotice(): string { return `Activity queue overflow: ${this.droppedEvents} unacknowledged events dropped (oldest first).`; }
  private send(): void {
    if (!this.port || !this.pending[0] || this.inFlight) return;
    this.inFlight = this.pending[0].request;
    try { this.port.postMessage(this.inFlight); }
    catch (e) { this.port.emit('error', e); }
  }
  /** Discards unacknowledged calls and prevents late worker messages from restarting retries. */
  cancel(): void {
    this.closed = true;
    clearTimeout(this.retry);
    const port = this.port;
    this.port = null;
    this.inFlight = null;
    void port?.terminate?.();
    for (const item of this.pending.splice(0)) item.reject(new Error('Activity worker closed'));
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.call('close');
    clearTimeout(this.retry);
  }
}
