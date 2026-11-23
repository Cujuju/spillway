import { EventEmitter } from 'node:events';
import type { CapturePage } from '@shared/archive';
import { activityLog } from './activityService';
import { management } from './managementClient';

/** Idle poll cadence when caught up to the proxy capture journal. */
const POLL_IDLE_MS = 3_000;
/** A busy pass yields to other IPC work; a fixed sleep would cap sustained message throughput. */
const DRAIN_YIELD_MS = 0;
/** Lease renewal cadence; shorter than the proxy's lease lifetime so capture never lapses. */
const LEASE_RENEW_MS = 20_000;
/** Proxy spool page size (CapturePageRecords in CLIProxyAPI). */
const CAPTURE_PAGE_LIMIT = 4;
/** Pages committed in one durable transaction + proxy ack (~4 MiB max) while draining a backlog. */
const PAGES_PER_BATCH = 16;
/** Backlog lag threshold before surfacing a visible capture-behind warning to the user. */
const CAPTURE_LAG_ALERT_MS = 5 * 60_000;

export type ArchiveSyncAlert = { kind: 'error' | 'lag'; message: string };

/** Polling is independent of inference and commits each batch before advancing the durable cursor. */
export class ArchiveSync extends EventEmitter {
  error: string | null = null;
  lagAt: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private active = false;
  private leased: boolean | undefined;
  private renewAt = 0;
  private alerted: 'error' | 'lag' | null = null;
  private run: Promise<void> = Promise.resolve();
  start(): Promise<void> { this.stop(); this.active = true; this.leased = undefined; const gen = this.generation; return this.run = this.tick(gen); }
  stop(): void { clearTimeout(this.timer); this.generation++; this.active = false; }
  async clear(): Promise<void> {
    const active = this.active; this.stop(); await this.run;
    await activityLog.call('archiveClear');
    try {
      await management.captureLease(false); await management.clearCaptures();
      await activityLog.call('archiveClearAcknowledged');
    } catch {
      throw new Error('Local bodies deleted; proxy journal deletion is pending until the proxy is available');
    } finally { if (active) await this.start(); }
  }
  async refresh(): Promise<void> {
    const active = this.active; this.stop(); const gen = this.generation; await this.run;
    if (!active || gen !== this.generation) { this.error = null; this.lagAt = null; this.alerted = null; return; }
    this.active = true; this.run = this.tick(gen); await this.run;
  }
  private updateAlerts(): void {
    if (this.error) {
      if (this.alerted !== 'error') { this.alerted = 'error'; this.emit('alert', { kind: 'error', message: this.error } satisfies ArchiveSyncAlert); }
    } else if (this.lagAt) {
      if (this.alerted !== 'lag') { this.alerted = 'lag'; this.emit('alert', { kind: 'lag', message: this.lagAt } satisfies ArchiveSyncAlert); }
    } else {
      this.alerted = null;
    }
  }
  private async flushBatch(batch: CapturePage[], epoch: string, cursor: number, gen: number): Promise<boolean> {
    if (!batch.length) return true;
    await activityLog.call('archiveIngestBatch', batch);
    if (gen !== this.generation) return false;
    const last = batch.at(-1)!;
    const committed = last.records.at(-1)?.sequence ?? cursor;
    if (last.version === 2 && committed > 0) await management.acknowledgeCaptures(epoch, committed);
    return gen === this.generation;
  }
  private async tick(gen: number): Promise<void> {
    let delay = POLL_IDLE_MS;
    let warning: string | null = null;
    try {
      const status = await activityLog.call('archiveStatus');
      if (gen !== this.generation) return;
      if (status.clearPending) {
        await management.captureLease(false); await management.clearCaptures();
        await activityLog.call('archiveClearAcknowledged'); this.leased = undefined;
      }
      if (this.leased !== status.policy.captureBodies || status.policy.captureBodies && Date.now() >= this.renewAt) {
        await management.captureLease(status.policy.captureBodies);
        this.leased = status.policy.captureBodies; this.renewAt = Date.now() + LEASE_RENEW_MS;
      }
      let cursor = status.sequence, epoch = status.epoch;
      let batch: CapturePage[] = [];
      let lastPage: CapturePage | null = null;
      for (let pages = 0; pages < PAGES_PER_BATCH && gen === this.generation; pages++) {
        let page = await management.captures(cursor);
        if (gen !== this.generation) return;
        if (epoch !== page.epoch) {
          if (batch.length && epoch !== null) {
            if (!await this.flushBatch(batch, epoch, cursor, gen)) return;
            batch = [];
          }
          cursor = 0; epoch = page.epoch; page = await management.captures(0);
          if (gen !== this.generation) return;
        }
        if (!status.policy.captureBodies && page.version === 1) break;
        if (page.error) warning = page.error;
        batch.push(page);
        lastPage = page;
        if (!page.records.length) break;
        cursor = page.records.at(-1)!.sequence;
        if (page.records.length < CAPTURE_PAGE_LIMIT) break;
      }
      if (batch.length && epoch !== null) {
        if (!await this.flushBatch(batch, epoch, cursor, gen)) return;
      }
      const draining = Boolean(lastPage && lastPage.records.length === CAPTURE_PAGE_LIMIT);
      if (draining) delay = DRAIN_YIELD_MS;
      const tailAt = lastPage?.records.at(-1)?.startedAt;
      const tailMs = typeof tailAt === 'string' ? Date.parse(tailAt) : NaN;
      this.lagAt = draining && Number.isFinite(tailMs) && Date.now() - tailMs >= CAPTURE_LAG_ALERT_MS ? tailAt! : null;
      this.error = warning;
      this.updateAlerts();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.updateAlerts();
    } finally {
      if (gen === this.generation && this.active) this.timer = setTimeout(() => { this.run = this.tick(gen); }, delay);
    }
  }
}
export const archiveSync = new ArchiveSync();
