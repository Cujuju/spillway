import { createMemo } from 'solid-js';
import type { Credential } from '@shared/types';
import { depletionAt, poolSummary, project } from '../lib/forecast';
import { poolShares } from '../lib/poolCapacity';
import { drainRatePerHour, drainSeries, pastSeries } from '../lib/poolHistory';
import { activityBuckets, history, now, settings } from '../store';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface PoolInput {
  provider: string;
  credentials: Credential[];
}

/** Chart span shared by every pool on one panel: lookback behind now, forecast ahead. */
export const chartFrom = () => now() - settings().dashboard.drainLookbackHours * HOUR_MS;
export const chartTo = () => now() + settings().dashboard.forecastDays * DAY_MS;

/**
 * One provider's pool for window `key`: remaining, drain rate, history and projection.
 * Accounts weigh by plan size, so a Pro and a Max account add up by what they hold.
 */
export function createPoolModel(pool: () => PoolInput, key: () => string | null, strategy: () => string) {
  const shares = createMemo(() => (key() ? poolShares(history(), pool().credentials, key()!, activityBuckets()) : new Map()));
  const summary = createMemo(() => (key() ? poolSummary(pool().credentials, key()!, shares()) : null));
  const rate = createMemo(() => (key() ? drainRatePerHour(history(), shares(), key()!, now(), settings().dashboard.drainLookbackHours) : null));
  const past = createMemo(() => {
    const k = key();
    const s = summary();
    if (!k || !s) return [];
    return [...pastSeries(history(), pool().credentials, k, chartFrom(), shares()), { t: now(), remaining: s.remaining }];
  });
  const projection = createMemo(() =>
    key() ? project(pool().credentials, key()!, rate() ?? 0, now(), settings().dashboard.forecastDays, strategy(), shares()) : null,
  );
  const drain = createMemo(() => (key() ? drainSeries(history(), shares(), key()!, chartFrom()) : []));
  const emptyAt = () => (rate() ? depletionAt(projection()?.points ?? []) : null);
  const plans = () => [...new Set(pool().credentials.filter((c) => !c.disabled).map((c) => c.plan?.label ?? 'Plan unknown'))].join(' + ');
  return { provider: () => pool().provider, summary, rate, past, projection, drain, emptyAt, plans };
}

export type PoolModel = ReturnType<typeof createPoolModel>;
