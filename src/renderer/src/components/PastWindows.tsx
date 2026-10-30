import { createMemo, For, Match, Switch } from 'solid-js';
import type { LimitWindow, WindowSummary } from '@shared/types';
import { missedReadingGapMs, windowEnd } from '@shared/usageWindows';
import { compactDuration, dateTime, dayTime, quotaPercent } from '../lib/format';
import { pastTimeline, windowStart } from '../lib/pastTimeline';
import { now, observedSpans, settings, windowSummaries } from '../store';

const FULL = 100;
const NO_USE = 0;
const SECOND_MS = 1000;

function outcome(s: WindowSummary): string {
  if (s.exhaustedAt === null) return 'Never ran out';
  const ended = s.endedAt === null ? 'reset' : 'it ended';
  return `Ran out ${dayTime(s.exhaustedAt)} · ${compactDuration(windowEnd(s) - s.exhaustedAt)} before ${ended}`;
}

/** Finished windows of one account and window, newest first, with the stretches between them that held none. */
export function PastWindows(props: { credentialId: string; window: LimitWindow }) {
  const maxGapMs = () => missedReadingGapMs(settings().dashboard.refreshIntervalSeconds * SECOND_MS);
  const missed = (gapMs: number) => gapMs > maxGapMs();
  const mine = <T extends { credentialId: string; key: string }>(list: T[]) => list.filter((x) => x.credentialId === props.credentialId && x.key === props.window.key);
  const entries = createMemo(() => pastTimeline(mine(windowSummaries()), mine(observedSpans()), props.window.durationMs, now(), maxGapMs()));
  /** Notes where the readings stop short of the window, so a partly unseen window never reads as complete. */
  const coverage = (s: WindowSummary) =>
    [
      missed(s.firstSampleAt - windowStart(s, props.window.durationMs)) ? `tracked from ${dateTime(s.firstSampleAt)}` : null,
      missed(windowEnd(s) - s.lastSampleAt) ? `last reading ${dateTime(s.lastSampleAt)}` : null,
    ].filter((n) => n !== null);
  /** Use is known to be zero only where the app was reading. */
  const idleNote = (from: number, to: number, trackedMs: number) => {
    const untrackedMs = to - from - trackedMs;
    if (!missed(untrackedMs)) return `No use for ${compactDuration(to - from)}`;
    if (!missed(trackedMs)) return `Not tracked for ${compactDuration(to - from)}`;
    return `No use in ${compactDuration(trackedMs)} tracked · ${compactDuration(untrackedMs)} not tracked`;
  };

  return (
    <div class="past-windows">
      <For each={entries()} fallback={<div class="muted past-windows-empty">No finished {props.window.label.toLowerCase()} windows yet. Each one appears here after its reset.</div>}>
        {(e) => (
          <Switch>
            <Match when={e.kind === 'window' && e.summary}>
              {(s) => (
                <div class="past-window" classList={{ exhausted: s().exhaustedAt !== null }}>
                  <span class="past-window-span">{dateTime(windowStart(s(), props.window.durationMs))} – {dateTime(windowEnd(s()))}</span>
                  <span class="past-window-bar">
                    <span class="fill" style={{ width: `${Math.min(FULL, s().peak)}%` }} />
                  </span>
                  <span class="past-window-peak" title="Most used in the window">{quotaPercent(s().peak)}</span>
                  <span class="past-window-note">{[outcome(s()), ...coverage(s())].join(' · ')}</span>
                </div>
              )}
            </Match>
            <Match when={e.kind === 'idle' && e}>
              {(gap) => (
                <div class="past-window idle">
                  <span class="past-window-span">{dateTime(gap().from)} – {dateTime(gap().to)}</span>
                  <span class="past-window-bar" />
                  <span class="past-window-peak" title="Most used in the stretch">{missed(gap().to - gap().from - gap().trackedMs) ? quotaPercent(null) : quotaPercent(NO_USE)}</span>
                  <span class="past-window-note">{idleNote(gap().from, gap().to, gap().trackedMs)}</span>
                </div>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}
