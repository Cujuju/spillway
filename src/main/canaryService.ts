import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CANARY_PROBES, type CanaryStatus } from '@shared/canary';
import { getSettings, onSettingsChange } from './settingsStore';
import { proxy } from './proxySupervisor';
import { proxyIdentity } from './proxyIdentity';
import { usage } from './usagePoller';
import { management } from './managementClient';
import { activityLog } from './activityService';
import { runCanaryProbe } from './canaryRunner';
/** Settings intervals are hours; scheduling uses milliseconds. */
const HOUR_MS = 60 * 60_000;
/** Startup credentials may arrive after scheduling; retry without consuming the interval. */
export const CANARY_SNAPSHOT_RETRY_MS = 5_000;
export class CanaryService extends EventEmitter {
  private running = false;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private dueAt: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  status(): CanaryStatus {
    const s = getSettings().canary;
    return { running: this.running, lastRunAt: this.lastRunAt, lastError: this.lastError, callsPerRun: s.targets.length * CANARY_PROBES.length, nextRunAt: s.enabled && !this.running && proxy.isRunning() ? this.dueAt : null };
  }
  async attach(): Promise<void> {
    this.lastRunAt = await activityLog.call('canaryLastRunAt');
    onSettingsChange(() => this.schedule());
    proxy.on('status', () => this.schedule());
    this.schedule();
  }
  private schedule(retry = false): void {
    clearTimeout(this.timer);
    const s = getSettings().canary;
    this.dueAt = new Date(retry ? Date.now() + CANARY_SNAPSHOT_RETRY_MS : (this.lastRunAt ? Date.parse(this.lastRunAt) : Date.now()) + s.intervalHours * HOUR_MS).toISOString();
    const next = this.status().nextRunAt;
    if (next) this.timer = setTimeout(() => {
      if (!usage.latest()?.credentials.length) { this.schedule(true); return; }
      try { this.runNow(); } catch (e) { this.lastError = String(e); this.schedule(true); }
    }, Math.max(0, Date.parse(next) - Date.now()));
    this.emit('change', this.status());
  }
  runNow(): CanaryStatus {
    if (this.running) return this.status();
    const status = proxy.getStatus(), clientApiKey = proxyIdentity().clientApiKeys[0];
    if (status.state !== 'running' || !status.endpoint) throw new Error('Start the local proxy before running canaries');
    if (!clientApiKey) throw new Error('Proxy client authentication is unavailable');
    if (!usage.latest()?.credentials.length) throw new Error('Wait for a usage snapshot with credentials before running canaries');
    this.running = true; this.lastRunAt = new Date().toISOString(); this.lastError = null;
    clearTimeout(this.timer); this.emit('change', this.status());
    void this.execute({ endpoint: status.endpoint, clientApiKey });
    return this.status();
  }
  private async execute(connection: { endpoint: string; clientApiKey: string }): Promise<void> {
    const targets = structuredClone(getSettings().canary.targets), batchId = randomUUID();
    try {
      const routes = new Map<string, Set<boolean>>();
      for (const c of usage.latest()?.credentials ?? []) {
        const models = await management.credentialModels(c.name);
        for (const m of models) {
          const provider = (m.ownedBy ?? c.provider).toLowerCase();
          const claude = provider === 'claude' || provider === 'anthropic';
          const set = routes.get(m.id) ?? new Set<boolean>(); set.add(claude); routes.set(m.id, set);
        }
      }
      for (const target of targets) {
        const route = routes.get(target.model);
        if (!route || route.size !== 1) {
          const error = `Unknown or ambiguous provider for canary model ${target.model}`;
          this.lastError = error;
          await activityLog.call('canarySave', CANARY_PROBES.map((probe) => ({
            id: randomUUID(), batchId, at: new Date().toISOString(), ...target, effectiveModel: null,
            probeId: probe.id, probeVersion: probe.version, outcome: 'error', answer: null, error,
            outputTokens: null, thinkingTokens: null, latencyMs: null,
          })));
          continue;
        }
        for (const probe of CANARY_PROBES) {
          const result = await runCanaryProbe(target, probe, batchId, [...route][0]!, connection);
          await activityLog.call('canarySave', [result]);
          if (result.error) this.lastError = result.error;
        }
      }
    } catch (e) { this.lastError = e instanceof Error ? e.message : String(e); }
    finally { this.running = false; this.schedule(); }
  }
}
export const canaryService = new CanaryService();
