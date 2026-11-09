import { exchangeInput, type ExchangeInput, type ExchangeSide } from '@shared/exchangeBody';

export type { ExchangeInput };
export interface ExchangeSides { request: ExchangeSide; response: ExchangeSide }

interface PendingParse {
  detail: ExchangeInput;
  resolve: (sides: ExchangeSides) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

const pending = new Map<number, PendingParse>();
let worker: Worker | null = null;
let nextId = 0;
// An aborted active job occupies the worker until its reply arrives.
let activeId: number | null = null;

function failWorker(cause: unknown): void {
  if (worker) {
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    worker = null;
  }
  activeId = null;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  for (const call of pending.values()) { call.cleanup(); call.reject(error); }
  pending.clear();
}

function dispatch(): void {
  if (activeId !== null) return;
  const next = pending.entries().next().value;
  if (!next) return;
  const [id, call] = next;
  try {
    if (!worker) {
      const created = new Worker(new URL('./exchangeParse.worker.ts', import.meta.url), { type: 'module' });
      worker = created;
      created.onmessage = ({ data }: MessageEvent<{ id: number; sides: ExchangeSides }>) => {
        if (worker !== created || data.id !== activeId) return;
        activeId = null;
        const finished = pending.get(data.id);
        pending.delete(data.id);
        if (finished) { finished.cleanup(); finished.resolve(data.sides); }
        dispatch();
      };
      created.onerror = (event) => failWorker(new Error(event.message || 'Exchange parse worker failed'));
      created.onmessageerror = () => failWorker(new Error('Exchange parse worker returned an unreadable reply'));
    }
    activeId = id;
    worker.postMessage({ id, detail: call.detail });
  } catch (error) { failWorker(error); }
}

/** Parses both sides in a Web Worker. Rejects with a DOMException named 'AbortError' if signal aborts first. */
export function parseExchange(detail: ExchangeInput, signal: AbortSignal): Promise<ExchangeSides> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Exchange parsing aborted', 'AbortError')); return; }
    const id = ++nextId;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      pending.delete(id);
      cleanup();
      reject(new DOMException('Exchange parsing aborted', 'AbortError'));
    };
    pending.set(id, { detail: exchangeInput(detail), resolve, reject, cleanup });
    signal.addEventListener('abort', abort, { once: true });
    dispatch();
  });
}
