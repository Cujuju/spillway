import { EventEmitter } from 'node:events';
import type { NoticeInput } from '@shared/notice';
import { maskEmails } from '@shared/privacy';
import { resetText } from '@shared/resetTime';
import type { ResetCreditOutcome, UsageSnapshot } from '@shared/types';
import { rollPastResets } from '@shared/usageWindows';
import { history } from './historyStore';
import { management, UsageRefreshError } from './managementClient';
import { proxy } from './proxySupervisor';
import { getSettings } from './settingsStore';
import { diffUsage, type UsageEvent } from './usageEvents';
import { notify } from './notifier';

const MS_PER_SECOND = 1000;

/** The notice for a usage event, or null when its notification is off. */
export function usageNotice(event: UsageEvent): NoticeInput | null {
  const { notifications: n, dashboard } = getSettings();
  // Notifications show on screen, so they honour "Show emails" like the window does.
  const name = (c: { label: string }) => (dashboard.showEmails ? c.label : maskEmails(c.label));
  if (event.kind === 'limitHit' && n.limitHit) {
    return { kind: 'limitHit', target: 'window', title: `${name(event.credential)}: ${event.windowLabel} limit reached`,
      body: event.resetsAt ? resetText(event.resetsAt, Date.now()) : 'Switching to the next account.', short: `${event.windowLabel} limit reached` };
  }
  if (event.kind === 'limitReset' && n.limitReset) {
    return { kind: 'limitReset', target: 'window', title: `${name(event.credential)}: ${event.windowLabel} limit reset`,
      body: 'The account is available again.', short: `${event.windowLabel} limit reset` };
  }
  if (event.kind === 'accountSwitched' && n.accountSwitched) {
    return { kind: 'accountSwitched', target: 'window', title: `${event.provider}: now using ${name(event.to)}`,
      body: event.from ? `Previously ${name(event.from)}.` : '', short: `${event.provider} → ${name(event.to)}` };
  }
  return null;
}

class UsagePoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private last: UsageSnapshot | null = null;
  private inFlight = false;
  private pollPending = false;
  private mutations: Promise<void> = Promise.resolve();
  private mutationRevision = 0;
  lastError: string | null = null;

  latest(): UsageSnapshot | null {
    return this.last;
  }

  /** Quota mutations share one order; live cache reads remain independent. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(run);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private acceptMutation(snapshot: UsageSnapshot): UsageSnapshot {
    this.mutationRevision++;
    return this.accept(snapshot);
  }

  private accept(fetched: UsageSnapshot): UsageSnapshot {
    const snapshot = rollPastResets(fetched, Date.parse(fetched.fetchedAt));
    for (const event of diffUsage(this.last, snapshot)) {
      const notice = usageNotice(event);
      if (notice) notify(notice);
    }
    this.last = snapshot;
    this.lastError = null;
    history.add(snapshot);
    this.emit('snapshot', snapshot);
    return snapshot;
  }

  async poll(): Promise<UsageSnapshot | null> {
    if (!proxy.isRunning()) return this.last;
    if (this.inFlight) {
      this.pollPending = true;
      return this.last;
    }
    this.inFlight = true;
    const revision = this.mutationRevision;
    try {
      const snapshot = await management.usage();
      if (revision !== this.mutationRevision) {
        this.pollPending = true;
        return this.last;
      }
      return this.accept(snapshot);
    } catch (err) {
      if (revision !== this.mutationRevision) {
        this.pollPending = true;
        return this.last;
      }
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit('error', this.lastError);
      return this.last;
    } finally {
      this.inFlight = false;
      if (this.pollPending) {
        this.pollPending = false;
        void this.poll();
      }
    }
  }

  /** Asks the proxy to re-read usage from the providers, then publishes the result. */
  async refresh(authIndex?: string): Promise<UsageSnapshot | null> {
    if (!proxy.isRunning()) return this.last;
    return this.enqueue(async () => {
      try {
        return this.acceptMutation(await management.refreshUsage(authIndex));
      } catch (err) {
        if (err instanceof UsageRefreshError) this.acceptMutation(err.snapshot);
        this.lastError = err instanceof Error ? err.message : String(err);
        this.emit('error', this.lastError);
        throw err;
      }
    });
  }

  /** Spends one of a Codex account's reset credits, then publishes the usage that follows. */
  async useResetCredit(authIndex: string): Promise<ResetCreditOutcome> {
    if (!proxy.isRunning()) throw new Error('Start the proxy first');
    return this.enqueue(async () => {
      const { outcome, snapshot } = await management.useResetCredit(authIndex);
      this.acceptMutation(snapshot);
      return outcome;
    });
  }

  /** Starts an account's 5-hour window now, then publishes the usage that follows. */
  async startWindow(authIndex: string, model: string): Promise<void> {
    if (!proxy.isRunning()) throw new Error('Start the proxy first');
    await this.enqueue(async () => { this.acceptMutation(await management.startWindow(authIndex, model)); });
  }

  start(): void {
    this.stop();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), getSettings().dashboard.refreshIntervalSeconds * MS_PER_SECOND);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const usage = new UsagePoller();
