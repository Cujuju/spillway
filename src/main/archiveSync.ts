import { activityLog } from './activityService';
import { management } from './managementClient';
// A busy pass yields to other IPC work; a fixed sleep would cap sustained message throughput.
const DRAIN_YIELD_MS = 0;

/** Polling is independent of inference and commits each page before advancing the durable cursor. */
export class ArchiveSync {
  error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private active = false;
  private leased: boolean | undefined;
  private renewAt = 0;
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
    if (!active || gen !== this.generation) { this.error = null; return; }
    this.active = true; this.run = this.tick(gen); await this.run;
  }
  private async tick(gen: number): Promise<void> {
    let delay = 3_000;
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
        this.leased = status.policy.captureBodies; this.renewAt = Date.now() + 20_000;
      }
      {
        let cursor = status.sequence, epoch = status.epoch;
        for (let pages = 0; pages < 4 && gen === this.generation; pages++) {
          let page = await management.captures(cursor);
          if (epoch !== page.epoch) { cursor = 0; epoch = page.epoch; page = await management.captures(0); }
          if (gen !== this.generation) return;
          if (!status.policy.captureBodies && page.version === 1) break;
          await activityLog.call('archiveIngest', page);
          const committed = page.records.at(-1)?.sequence ?? cursor;
          if (gen !== this.generation) return;
          if (page.version === 2 && committed > 0) await management.acknowledgeCaptures(page.epoch, committed);
          if (page.error) warning = page.error;
          if (!page.records.length) break;
          cursor = page.records.at(-1)!.sequence;
          if (pages === 3 && page.records.length === 4) delay = DRAIN_YIELD_MS;
        }
      }
      this.error = warning;
    } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    finally {
      if (gen === this.generation && this.active) this.timer = setTimeout(() => { this.run = this.tick(gen); }, delay);
    }
  }
}
export const archiveSync = new ArchiveSync();
