import type { Worker } from 'node:worker_threads';
import { priceTableSnapshot } from '@shared/modelPrices';

/** Owns one background pass at a time. Errors leave the stored snapshot pending for the next launch. */
export class ActivityRepriceJob {
  private worker: Worker | null = null;
  private stopped = false;
  /** Prices changed while a pass ran; that pass used the old table. */
  private rerun = false;
  constructor(private createWorker: () => Worker, private changed: () => Promise<unknown>) {}
  start(previous: string | null): void {
    if (this.stopped || previous === priceTableSnapshot()) return;
    if (this.worker) { this.rerun = true; return; }
    try {
      const worker = this.createWorker();
      this.worker = worker;
      worker.on('message', (changed: boolean) => {
        if (changed && !this.stopped) void this.changed().catch((error) => console.error('[activity] repricing refresh failed:', error));
      });
      worker.on('error', (error) => console.error('[activity] repricing failed:', error));
      worker.on('exit', (code) => {
        this.worker = null;
        if (code && !this.stopped) console.error('[activity] repricing exited:', code);
        // The worker compares the stored snapshot itself, so an unneeded rerun exits without writing.
        if (this.rerun) { this.rerun = false; this.start(null); }
      });
    } catch (error) { console.error('[activity] repricing failed:', error); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.worker?.terminate();
    this.worker = null;
  }
}
