import { EventEmitter } from 'node:events';
import { Notification } from 'electron';
import { maskEmails } from '@shared/privacy';
import { resetText } from '@shared/resetTime';
import type { ResetCreditOutcome, UsageSnapshot } from '@shared/types';
import { rollPastResets } from '@shared/usageWindows';
import { history } from './historyStore';
import { management } from './managementClient';
import { proxy } from './proxySupervisor';
import { getSettings } from './settingsStore';
import { diffUsage, type UsageEvent } from './usageEvents';
import { appIconPath } from './paths';

const MS_PER_SECOND = 1000;

function notify(event: UsageEvent): void {
  const { notifications: n, dashboard } = getSettings();
  // Notifications show on screen, so they honour "Show emails" like the window does.
  const name = (c: { label: string }) => (dashboard.showEmails ? c.label : maskEmails(c.label));
  let title = '';
  let body = '';
  if (event.kind === 'limitHit' && n.limitHit) {
    title = `${name(event.credential)}: ${event.windowLabel} limit reached`;
    body = event.resetsAt ? resetText(event.resetsAt, Date.now()) : 'Switching to the next account.';
  } else if (event.kind === 'limitReset' && n.limitReset) {
    title = `${name(event.credential)}: ${event.windowLabel} limit reset`;
    body = 'The account is available again.';
  } else if (event.kind === 'accountSwitched' && n.accountSwitched) {
    title = `${event.provider}: now using ${name(event.to)}`;
    body = event.from ? `Previously ${name(event.from)}.` : '';
  }
  if (title && Notification.isSupported()) new Notification({ title, body, icon: appIconPath() }).show();
}

class UsagePoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private last: UsageSnapshot | null = null;
  private inFlight = false;
  lastError: string | null = null;

  latest(): UsageSnapshot | null {
    return this.last;
  }

  private accept(fetched: UsageSnapshot): UsageSnapshot {
    const snapshot = rollPastResets(fetched, Date.parse(fetched.fetchedAt));
    for (const event of diffUsage(this.last, snapshot)) notify(event);
    this.last = snapshot;
    this.lastError = null;
    history.add(snapshot);
    this.emit('snapshot', snapshot);
    return snapshot;
  }

  async poll(): Promise<UsageSnapshot | null> {
    if (this.inFlight || !proxy.isRunning()) return this.last;
    this.inFlight = true;
    try {
      return this.accept(await management.usage());
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit('error', this.lastError);
      return this.last;
    } finally {
      this.inFlight = false;
    }
  }

  /** Asks the proxy to re-read usage from the providers, then publishes the result. */
  async refresh(authIndex?: string): Promise<UsageSnapshot | null> {
    if (!proxy.isRunning()) return this.last;
    return this.accept(await management.refreshUsage(authIndex));
  }

  /** Spends one of a Codex account's reset credits, then publishes the usage that follows. */
  async useResetCredit(authIndex: string): Promise<ResetCreditOutcome> {
    if (!proxy.isRunning()) throw new Error('Start the proxy first');
    const { outcome, snapshot } = await management.useResetCredit(authIndex);
    this.accept(snapshot);
    return outcome;
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
