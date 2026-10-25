import { EventEmitter } from 'node:events';
import { MAX_ACTIVITY_EVENTS, type ActivityEvent } from '@shared/types';
import { management } from './managementClient';
import { parseActivityEvent, SseParser } from './sse';
import { usage } from './usagePoller';

/** A burst of requests triggers one usage refresh, after it settles. */
const USAGE_REFRESH_DEBOUNCE_MS = 2_000;
/** The stream drops when the proxy restarts or reloads; reconnect while it should be running. */
const RECONNECT_MS = 2_000;

/** Reads the proxy's live request stream: keeps recent attempts and refreshes usage when traffic changed it. */
class ActivityStream extends EventEmitter {
  private events: ActivityEvent[] = [];
  private abort: AbortController | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  all(): ActivityEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }

  start(): void {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    void this.run(abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.read(await management.events(signal), signal);
      } catch (err) {
        if (signal.aborted) return;
        console.error('[activity] stream failed:', err instanceof Error ? err.message : err);
      }
      // A dropped stream may have missed events; the next poll catches usage up.
      if (!signal.aborted) this.scheduleUsageRefresh();
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  }

  private async read(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) this.onMessage(msg.event, msg.data);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private onMessage(event: string, data: string): void {
    if (event === 'resync') return this.scheduleUsageRefresh();
    if (event !== 'request') return;
    const e = parseActivityEvent(data);
    if (!e) return;
    this.events = this.events.length >= MAX_ACTIVITY_EVENTS ? [...this.events.slice(1), e] : [...this.events, e];
    this.emit('event', e);
    this.scheduleUsageRefresh();
  }

  private scheduleUsageRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void usage.poll();
    }, USAGE_REFRESH_DEBOUNCE_MS);
  }
}

export const activity = new ActivityStream();
