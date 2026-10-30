import { EventEmitter } from 'node:events';
import type { ActivityMethods, Method, Request, WorkerMessage } from './activityProtocol';
/** One second avoids a hot crash loop while keeping queued proxy events close to real time. */
export const ACTIVITY_RESTART_BACKOFF_MS = 1_000;
export interface RpcPort extends EventEmitter { postMessage(message: Request): void }
interface Pending { request: Request; resolve(value: unknown): void; reject(error: Error): void }
/** Keeps unacknowledged requests in order across crashes; database mutations must be replay-safe. */
export class ActivityRpc extends EventEmitter {
  private port: RpcPort | null = null;
  private pending: Pending[] = [];
  private nextId = 0;
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
        if ('event' in message) { this.emit(message.event, 'value' in message ? message.value : undefined); return; }
        const item = this.pending[0];
        if (!item || item.request.id !== message.id) return;
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
      this.pending.push({ request: { id: ++this.nextId, method, args } as Request, resolve: resolve as (value: unknown) => void, reject });
      if (this.pending.length === 1) this.send();
    });
  }
  private send(): void {
    if (!this.port || !this.pending[0]) return;
    try { this.port.postMessage(this.pending[0].request); }
    catch (e) { this.port.emit('error', e); }
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.call('close');
    clearTimeout(this.retry);
  }
}
