/** DevTools Protocol helpers for scripted runs of the demo app (screenshots, smoke). */

import { createServer } from 'node:net';

const POLL_MS = 250;
/** Startup plus storing a few thousand replayed requests; a minute is several times what it takes. */
const READY_TIMEOUT_MS = 60_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Polls until probe returns a value; fails early when `abort` returns a reason. */
export async function until<T>(what: string, probe: () => Promise<T | null | undefined>, abort?: () => string | null): Promise<T> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reason = abort?.();
    if (reason) throw new Error(`${reason} while waiting for ${what}`);
    const value = await probe().catch(() => null);
    if (value !== null && value !== undefined) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Minimal CDP client for one page target. */
export class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: unknown) => void)[]>();
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('close', () => {
      for (const call of this.pending.values()) call.reject(new Error('the DevTools connection closed'));
      this.pending.clear();
    });
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      if (msg.method) for (const listener of this.listeners.get(msg.method) ?? []) listener(msg.params);
      const call = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id!);
      if (msg.error) call.reject(new Error(msg.error.message));
      else call.resolve(msg.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }

  /** The app's main window target on a debugging port. */
  static async mainWindow(port: number, abort?: () => string | null): Promise<Cdp> {
    const target = await until('the app window', async () => {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      return list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    }, abort);
    return Cdp.connect(target.webSocketDebuggerUrl);
  }

  on<T>(method: string, listener: (params: T) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener as (params: unknown) => void]);
  }

  /** Rejects when the connection closes or the page doesn't answer within READY_TIMEOUT_MS (a hung renderer). */
  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the DevTools connection closed'));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer`));
      }, READY_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** Runs an expression in the page, awaiting promises; returns its JSON value. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }

  close(): void {
    this.ws.close();
  }
}
