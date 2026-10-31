import type { Credential, HistorySample, WindowSummary } from '@shared/types';
import { windowEnd } from '@shared/usageWindows';
import type { AccountShare } from './poolCapacity';
import { consumed } from './poolHistory';

const HOUR_MS = 3_600_000;
const FULL = 100;
/** One hour catches bursts without extrapolating the whole dashboard lookback. */
const RECENT_HOURS = 1;
/** Prior exposure scales with window length, damping tiny early weekly changes. */
const PRIOR_WINDOW_SHARE = 0.1;
/** Recent finished windows adapt to changing workloads without retaining ancient habits. */
const PRIOR_WINDOWS = 5;

/** Recent use plus finished-window baseline, in pool percent per hour; null without observed history. */
export function forecastRate(
  samples: HistorySample[], summaries: WindowSummary[], credentials: Credential[], key: string,
  shares: Map<string, AccountShare>, now: number,
): number | null {
  let total = 0;
  let observed = false;
  for (const c of credentials) {
    const share = shares.get(c.id);
    if (!share) continue;
    const recent = samples.filter((s) => Date.parse(s.at) >= now - RECENT_HOURS * HOUR_MS
      && Date.parse(s.at) <= now && s.used[c.id]?.[key] !== undefined);
    if (recent.length < 2) continue;
    const hours = (Date.parse(recent.at(-1)!.at) - Date.parse(recent[0]!.at)) / HOUR_MS;
    if (hours <= 0) continue;
    observed = true;
    const duration = c.windows.find((w) => w.key === key)?.durationMs;
    const finished = summaries.filter((s) => s.credentialId === c.id && s.key === key && windowEnd(s) <= now)
      .sort((a, b) => windowEnd(b) - windowEnd(a)).slice(0, PRIOR_WINDOWS);
    const prior = duration && duration > 0 ? finished.flatMap((s) => {
      const span = (s.exhaustedAt ?? windowEnd(s)) - (s.resetAt - duration);
      return span > 0 ? [Math.min(FULL, Math.max(0, s.peak)) * HOUR_MS / span] : [];
    }) : [];
    const exposure = prior.length && duration ? duration / HOUR_MS * PRIOR_WINDOW_SHARE : 0;
    const baseline = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
    total += share.share * (consumed(recent, [c.id], key) + baseline * exposure) / (hours + exposure);
  }
  return observed ? total : null;
}
