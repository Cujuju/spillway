import { cheapestModel } from '@shared/modelPrices';
import type { Credential, UsageSnapshot, WindowStartStatus } from '@shared/types';
import type { WindowStartProvider } from '@shared/windowStartSettings';
import { management, ManagementError } from './managementClient';
import { getSettings } from './settingsStore';
import { usage } from './usagePoller';
import { dueForWindowStart } from './windowStartPlan';

/** A failed account waits this long before another try, as the proxy's usage lookups do after a failure. */
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
/** The proxy found the window already running; the next snapshot shows it. */
const HTTP_CONFLICT = 409;

/** Starts each account's 5-hour window when the usage poller sees it idle (Settings → Rolling windows). */
class WindowStarter {
  private busy = false;
  /** Credential id → when the app started its window. */
  private readonly started = new Map<string, number>();
  private readonly failedAt = new Map<string, number>();
  /** Credential name → model ids it offers; dropped after a failure so a changed list is re-read. */
  private readonly models = new Map<string, string[]>();
  private current: WindowStartStatus = { lastStart: null, lastError: null };

  status(): WindowStartStatus {
    return this.current;
  }

  attach(): void {
    usage.on('snapshot', (s: UsageSnapshot) => void this.run(s));
  }

  private async run(snapshot: UsageSnapshot): Promise<void> {
    // Each start publishes a snapshot, which re-enters here; the running pass covers it.
    if (this.busy) return;
    this.busy = true;
    try {
      const settings = getSettings().windowStart;
      const now = Date.now();
      for (const c of dueForWindowStart(snapshot, settings, new Date(now), this.started)) {
        if (now - (this.failedAt.get(c.id) ?? -Infinity) < RETRY_AFTER_FAILURE_MS) continue;
        await this.start(c, settings.models[c.provider as WindowStartProvider]);
      }
    } finally {
      this.busy = false;
    }
  }

  private async start(c: Credential, configured: string): Promise<void> {
    try {
      const model = configured || (await this.cheapest(c));
      if (!model) throw new Error('The account offers no model with a known price; pick one in Settings → Rolling windows.');
      const at = Date.now();
      await usage.startWindow(c.authIndex, model);
      this.started.set(c.id, at);
      this.failedAt.delete(c.id);
      this.current = { ...this.current, lastStart: { credentialId: c.id, model, at: new Date(at).toISOString() } };
    } catch (err) {
      if (err instanceof ManagementError && err.status === HTTP_CONFLICT) return;
      const message = err instanceof Error ? err.message : String(err);
      this.failedAt.set(c.id, Date.now());
      this.models.delete(c.name);
      this.current = { ...this.current, lastError: { credentialId: c.id, message, at: new Date().toISOString() } };
      console.warn(`[window-start] ${c.id}: ${message}`);
    }
  }

  private async cheapest(c: Credential): Promise<string | null> {
    let ids = this.models.get(c.name);
    if (!ids) {
      ids = (await management.credentialModels(c.name)).map((m) => m.id);
      this.models.set(c.name, ids);
    }
    return cheapestModel(ids);
  }
}

export const windowStarter = new WindowStarter();
