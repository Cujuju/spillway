import { activityLog } from './activityService';
import { management } from './managementClient';

/** Polling is independent of inference and commits each page before advancing the durable cursor. */
export class ArchiveSync {
  error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private run: Promise<void> = Promise.resolve();
  start(): void { this.stop(); const gen = this.generation; this.run = this.tick(gen); }
  stop(): void { clearTimeout(this.timer); this.generation++; }
  async refresh(): Promise<void> {
    this.stop(); await this.run;
    const gen = this.generation; this.run = this.tick(gen); await this.run;
  }
  private async tick(gen: number): Promise<void> {
    try {
      const status = await activityLog.call('archiveStatus');
      if (gen !== this.generation) return;
      await management.captureLease(status.policy.captureBodies);
      if (status.policy.captureBodies) {
        let cursor = status.sequence, epoch = status.epoch;
        for (let pages = 0; pages < 4 && gen === this.generation; pages++) {
          let page = await management.captures(cursor);
          if (epoch !== page.epoch) { cursor = 0; epoch = page.epoch; page = await management.captures(0); }
          if (gen !== this.generation) return;
          await activityLog.call('archiveIngest', page);
          if (!page.records.length) break;
          cursor = page.records.at(-1)!.sequence;
        }
      }
      this.error = null;
    } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    finally {
      if (gen === this.generation) this.timer = setTimeout(() => { this.run = this.tick(gen); }, 3_000);
    }
  }
}
export const archiveSync = new ArchiveSync();
