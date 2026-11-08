import type { ClickHouseBatch, ClickHouseConfig, ClickHouseCredentials, ClickHouseStatus } from '@shared/clickhouse';
import { checkClickHouseSchema, clickhouseDDL, clickhouseRequest, insertClickHouse } from './clickhouseHttp';
import { clickhouseDestination } from './clickhouseStore';
export const DELIVERY_INTERVAL_MS = 3_000;

export interface ClickHouseWorker {
  status(): Promise<Omit<ClickHouseStatus, 'hasCredentials' | 'running' | 'paused'>>;
  prepare(): Promise<ClickHouseBatch | null>;
  acknowledge(token: string, destination: string): Promise<void>;
  fail(token: string, now: number, error: string): Promise<void>;
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(new Error('ClickHouse operation cancelled; delivery may be uncertain'));
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
}
/** HTTP waits never occupy the Activity worker's RPC queue. */
export class ClickHouseUploader {
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | null = null;
  private stopped = true;
  private verifiedDestination: string | null = null;
  error: string | null = null;
  get running(): boolean { return this.controller !== null; }
  get paused(): boolean { return this.stopped; }
  constructor(private worker: ClickHouseWorker, private credentials: (config: ClickHouseConfig) => ClickHouseCredentials | undefined) {}
  start(): void { this.verifiedDestination = null; this.stopped = false; this.schedule(0); }
  private schedule(ms: number): void {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => {
      // runOnce reports its own failures; the catch keeps delivery scheduled if one escapes.
      this.active = this.runOnce().catch(() => { this.error = 'ClickHouse delivery failed unexpectedly'; return false; })
        .then((acknowledged) => { this.active = null; this.schedule(acknowledged ? 0 : DELIVERY_INTERVAL_MS); });
    }, ms);
  }
  async stop(): Promise<void> {
    this.verifiedDestination = null;
    this.stopped = true; clearTimeout(this.timer); this.controller?.abort(); await this.active;
  }
  async runOnce(now = Date.now()): Promise<boolean> {
    if (this.controller) return false;
    const controller = new AbortController(); this.controller = controller;
    let batch: ClickHouseBatch | null = null;
    try {
      const state = await abortable(this.worker.status(), controller.signal);
      const destination = clickhouseDestination(state.config);
      if (this.verifiedDestination !== destination) this.verifiedDestination = null;
      if (controller.signal.aborted || !state.config.enabled || state.nextAttemptAt > now) return false;
      batch = await abortable(this.worker.prepare(), controller.signal);
      if (!batch || controller.signal.aborted) return false;
      if (batch.destination !== destination) throw new Error('ClickHouse batch destination changed; delivery paused');
      if (this.verifiedDestination !== destination) {
        await checkClickHouseSchema(state.config, this.credentials(state.config), controller.signal);
        if (controller.signal.aborted) return false;
        this.verifiedDestination = destination;
      }
      if (batch.pieces) await insertClickHouse(state.config, this.credentials(state.config), batch.pieces, controller.signal, 'pieces');
      await insertClickHouse(state.config, this.credentials(state.config), batch.facts, controller.signal);
      if (controller.signal.aborted) return false;
      await abortable(this.worker.acknowledge(batch.token, batch.destination), controller.signal);
      this.error = null;
      return true;
    } catch (e) {
      this.verifiedDestination = null;
      this.error = e instanceof Error ? e.message : 'ClickHouse upload failed';
      if (batch && !controller.signal.aborted) {
        try { await abortable(this.worker.fail(batch.token, Math.max(now, Date.now()), this.error), controller.signal); }
        catch { this.error = 'ClickHouse local outbox update failed; retry retained'; }
      }
      return false;
    } finally { this.controller = null; }
  }
  async diagnose(config: ClickHouseConfig, create = false): Promise<string> {
    this.verifiedDestination = null;
    if (this.controller) throw new Error('ClickHouse operation already running');
    const controller = new AbortController(); this.controller = controller;
    try {
      if (create) for (const kind of ['pieces', 'facts']) if ((await clickhouseRequest(config, this.credentials(config), clickhouseDDL(config, kind), controller.signal)).trim()) throw new Error('ClickHouse schema creation returned an unexpected response');
      await checkClickHouseSchema(config, this.credentials(config), controller.signal);
      this.error = null; return 'Connected; archive schema v1 is compatible. Insert permission is checked on delivery.';
    } catch (e) { this.error = e instanceof Error ? e.message : 'ClickHouse diagnostic failed'; throw new Error(this.error); }
    finally { this.controller = null; }
  }
}
