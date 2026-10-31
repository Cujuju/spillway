import type { Credential, HistorySample, WindowSummary } from '@shared/types';
import { windowEnd } from '@shared/usageWindows';
import type { AccountShare } from './poolCapacity';
import { consumed } from './poolHistory';
import { FLAT_RHYTHM, localOffset, weightedHours, type RhythmProfile, type TimezoneOffset } from './rhythmProfile';

const HOUR_MS = 3_600_000;
const FULL = 100;
/** Prior exposure scales with window length, damping tiny early weekly changes. */
const PRIOR_WINDOW_SHARE = 0.1;
/** Recent finished windows adapt to changing workloads without retaining ancient habits. */
const PRIOR_WINDOWS = 5;

/** Current-window use plus a historical prior, in pool percent per average-weight hour; null without evidence. */
export function forecastRate(
  samples: HistorySample[], summaries: WindowSummary[], credentials: Credential[], key: string,
  shares: Map<string, AccountShare>, now: number, lookbackHours: number,
  profile: RhythmProfile = FLAT_RHYTHM, offset: TimezoneOffset = localOffset,
): number | null {
  let total = 0;
  let observed = false;
  const flat = profile.every((n) => n === 1);
  for (const c of credentials) {
    const share = shares.get(c.id);
    if (!share) continue;
    const window = c.windows.find((w) => w.key === key);
    const duration = window?.durationMs;
    const finished = summaries.filter((s) => s.credentialId === c.id && s.key === key && windowEnd(s) <= now)
      .sort((a, b) => windowEnd(b) - windowEnd(a)).slice(0, PRIOR_WINDOWS);
    const prior = duration && duration > 0 ? finished.flatMap((s) => {
      const from = s.resetAt - duration;
      const to = s.exhaustedAt ?? windowEnd(s);
      const span = flat ? to - from : weightedHours(from, to, profile, offset) * HOUR_MS;
      return span > 0 ? [Math.min(FULL, Math.max(0, s.peak)) * HOUR_MS / span] : [];
    }) : [];
    const history = samples.filter((s) => Date.parse(s.at) >= now - lookbackHours * HOUR_MS
      && Date.parse(s.at) <= now && s.used[c.id]?.[key] !== undefined);
    const hours = history.length >= 2 ? weightedHours(Date.parse(history[0]!.at), Date.parse(history.at(-1)!.at), profile, offset) : 0;
    const baseline = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length
      : hours > 0 ? consumed(history, [c.id], key) / hours : null;
    const elapsed = window?.resetsAt && duration && duration > 0
      ? weightedHours(Date.parse(window.resetsAt) - duration, now, profile, offset) : 0;
    const used = window?.usedPercent;
    if (baseline !== null || used != null) observed = true;
    if (used == null || !(elapsed > 0)) {
      total += share.share * (baseline ?? 0);
      continue;
    }
    const exposure = baseline !== null ? duration! / HOUR_MS * PRIOR_WINDOW_SHARE : 0;
    total += share.share * (used + (baseline ?? 0) * exposure) / (elapsed + exposure);
  }
  return observed ? total : null;
}
