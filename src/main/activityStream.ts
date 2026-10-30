import { EventEmitter } from 'node:events';
import { activityLog } from './activityService';
import { management } from './managementClient';
import { parseActivityEvent, SseParser } from './sse';
import { usage } from './usagePoller';

/** Bound event-triggered staleness even while requests keep arriving. */
const USAGE_REFRESH_DELAY_MS = 2_000;
/** The stream drops when the proxy restarts or reloads; reconnect while it should be running. */
const RECONNECT_MS = 2_000;
/** Stream events that only mean "reload usage" (docs/desktop-api.md in the fork). */
const USAGE_RELOAD_EVENTS = new Set(['ready', 'resync', 'usage']);

/** Reads the proxy's live request stream: stores each attempt and refreshes usage when traffic changed it. */
class ActivityStream extends EventEmitter {
  private reading: Promise<void> = Promise.resolve();
  private draining = false;
  private running: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  start(): void {
    void this.stop();
    this.draining = false;
    const abort = new AbortController();
    this.abort = abort;
    this.running = this.run(abort.signal);
  }

  async stop(drain = false): Promise<void> {
    this.draining = true;
    if (drain) await this.reading.catch(() => undefined);
    this.abort?.abort();
    this.abort = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    return this.running;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const body = await management.events(signal);
        this.reading = this.read(body, signal);
        await this.reading;
      } catch (err) {
        if (signal.aborted) return;
        console.error('[activity] stream failed:', err instanceof Error ? err.message : err);
      }
      // A dropped stream may have missed events; the next poll catches usage up.
      if (signal.aborted || this.draining) return;
      this.scheduleUsageRefresh();
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
    // ready: lookups may have landed before the stream connected. usage: the proxy recorded new quota windows.
    if (USAGE_RELOAD_EVENTS.has(event)) return this.scheduleUsageRefresh();
    if (event !== 'request') return;
    const e = parseActivityEvent(data);
    if (!e) return;
    void activityLog.call('append', e).then((stored) => {
      this.emit('event', stored);
      this.scheduleUsageRefresh();
    }).catch((err) => {
      console.error('[activity] request not stored:', err);
      this.scheduleUsageRefresh();
    });
  }

  private scheduleUsageRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void usage.poll();
    }, USAGE_REFRESH_DELAY_MS);
  }
}

export const activity = new ActivityStream();
