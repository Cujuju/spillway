import { activityLog } from './activityService';
import { management } from './managementClient';

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
  async refresh(): Promise<void> {
    const active = this.active; this.stop(); const gen = this.generation; await this.run;
    if (!active || gen !== this.generation) { this.error = null; return; }
    this.active = true; this.run = this.tick(gen); await this.run;
  }
  private async tick(gen: number): Promise<void> {
    let delay = 3_000;
    try {
      const status = await activityLog.call('archiveStatus');
      if (gen !== this.generation) return;
      if (this.leased !== status.policy.captureBodies || status.policy.captureBodies && Date.now() >= this.renewAt) {
        await management.captureLease(status.policy.captureBodies);
        this.leased = status.policy.captureBodies; this.renewAt = Date.now() + 20_000;
      }
      if (status.policy.captureBodies) {
        let cursor = status.sequence, epoch = status.epoch;
        for (let pages = 0; pages < 4 && gen === this.generation; pages++) {
          let page = await management.captures(cursor);
          if (epoch !== page.epoch) { cursor = 0; epoch = page.epoch; page = await management.captures(0); }
          if (gen !== this.generation) return;
          await activityLog.call('archiveIngest', page);
          if (!page.records.length) break;
          cursor = page.records.at(-1)!.sequence;
          if (pages === 3 && page.records.length === 4) delay = 50;
        }
      }
      this.error = null;
    } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    finally {
      if (gen === this.generation && this.active) this.timer = setTimeout(() => { this.run = this.tick(gen); }, delay);
    }
  }
}
export const archiveSync = new ArchiveSync();
