import type { Worker } from 'node:worker_threads';
import type { DiagnosticSource } from '@shared/diagnosticBundle';
import type { DiagnosticFormatter, DiagnosticPreparedContent } from './diagnosticPreparation';

/** One bounded record in flight; cancel terminates CPU work independently of Electron and the Activity queue. */
export class DiagnosticFormatRpc implements DiagnosticFormatter {
  private pending?: { resolve(value: unknown): void; reject(error: Error): void };
  private stopped?: Error;
  private terminated?: Promise<number>;
  private abort: () => void;
  constructor(private worker: Worker, private signal: AbortSignal) {
    worker.on('message', (message: { value?: unknown; error?: string }) => {
      const pending = this.pending; this.pending = undefined;
      if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.value);
    });
    worker.on('error', () => this.stop(new Error('Diagnostic formatting worker failed')));
    worker.on('exit', () => this.stop(new Error('Diagnostic formatting worker stopped')));
    this.abort = () => this.stop(new Error('Diagnostic export canceled'));
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  private stop(error: Error): void {
    this.stopped ??= error;
    this.pending?.reject(this.stopped); this.pending = undefined;
    this.terminated ??= this.worker.terminate();
    this.signal.removeEventListener('abort', this.abort);
  }
  private call(method: 'add' | 'finish', source?: DiagnosticSource): Promise<unknown> {
    if (this.stopped) return Promise.reject(this.stopped);
    if (this.pending) return Promise.reject(new Error('Diagnostic formatter already busy'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try { this.worker.postMessage({ method, source }); }
      catch { this.stop(new Error('Diagnostic formatting worker unavailable')); }
    });
  }
  async add(source: DiagnosticSource): Promise<void> { await this.call('add', source); }
  async finish(): Promise<DiagnosticPreparedContent> { return await this.call('finish') as DiagnosticPreparedContent; }
  async close(): Promise<void> { this.stop(new Error('Diagnostic formatter closed')); await this.terminated; }
}
