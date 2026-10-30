import { createMemo, For } from 'solid-js';
import type { LimitWindow, WindowSummary } from '@shared/types';
import { HISTORY_SAMPLE_SPACING_MS, windowEnd } from '@shared/usageWindows';
import { compactDuration, dateTime, dayTime, quotaPercent } from '../lib/format';
import { now, settings, windowSummaries } from '../store';

const FULL = 100;
const SECOND_MS = 1000;
/** A gap over two reading intervals (one failed lookup allowed) means the app missed part of the window. */
const MISSED_GAP_READINGS = 2;

const windowStart = (s: WindowSummary, durationMs: number | null) => (durationMs ? s.resetAt - durationMs : s.firstSampleAt);

function outcome(s: WindowSummary): string {
  if (s.exhaustedAt === null) return 'Never ran out';
  const ended = s.endedAt === null ? 'reset' : 'it ended';
  return `Ran out ${dayTime(s.exhaustedAt)} · ${compactDuration(windowEnd(s) - s.exhaustedAt)} before ${ended}`;
}

/** Finished windows of one account and window, newest first: span, peak, and when it ran out. */
export function PastWindows(props: { credentialId: string; window: LimitWindow }) {
  // The store also holds the window in progress; only windows past their end are finished.
  const rows = createMemo(() =>
    windowSummaries().filter((s) => s.credentialId === props.credentialId && s.key === props.window.key && windowEnd(s) <= now()).reverse(),
  );
  // Live readings come each refresh; ones backfilled from history are a sample spacing apart. The wider interval holds for both.
  const readingInterval = () => Math.max(settings().dashboard.refreshIntervalSeconds * SECOND_MS, HISTORY_SAMPLE_SPACING_MS);
  const missed = (gapMs: number) => gapMs > MISSED_GAP_READINGS * readingInterval();
  /** Notes where the readings stop short of the window, so a partly unseen window never reads as complete. */
  const coverage = (s: WindowSummary) =>
    [
      missed(s.firstSampleAt - windowStart(s, props.window.durationMs)) ? `tracked from ${dateTime(s.firstSampleAt)}` : null,
      missed(windowEnd(s) - s.lastSampleAt) ? `last reading ${dateTime(s.lastSampleAt)}` : null,
    ].filter((n) => n !== null);

  return (
    <div class="past-windows">
      <For each={rows()} fallback={<div class="muted past-windows-empty">No finished {props.window.label.toLowerCase()} windows yet. Each one appears here after its reset.</div>}>
        {(s) => (
          <div class="past-window" classList={{ exhausted: s.exhaustedAt !== null }}>
            <span class="past-window-span">{dateTime(windowStart(s, props.window.durationMs))} – {dateTime(windowEnd(s))}</span>
            <span class="past-window-bar">
              <span class="fill" style={{ width: `${Math.min(FULL, s.peak)}%` }} />
            </span>
            <span class="past-window-peak" title="Most used in the window">{quotaPercent(s.peak)}</span>
            <span class="past-window-note">
              {[outcome(s), ...coverage(s)].join(' · ')}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
