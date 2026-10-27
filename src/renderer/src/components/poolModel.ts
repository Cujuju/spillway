import { createMemo, mapArray } from 'solid-js';
import type { Credential } from '@shared/types';
import { poolSummary, project } from '../lib/forecast';
import { poolShares } from '../lib/poolCapacity';
import { drainRatePerHour, drainSeries, pastSeries } from '../lib/poolHistory';
import { keyForDuration, nextResetAt, poolSegments, type WindowChoice } from '../lib/poolWindows';
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

/** Percent of the pool left in `key` now, by the Dashboard's math; tray icons and the tray tooltip read it. */
export const poolRemaining = (credentials: Credential[], key: string) =>
  poolSummary(credentials, key, poolShares(history(), credentials, key, activityBuckets())).remaining;

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
  const segments = createMemo(() => (key() ? poolSegments(pool().credentials, key()!, shares()) : []));
  const resetAt = () => (key() ? nextResetAt(pool().credentials, key()!, now()) : null);
  const plans = () => [...new Set(pool().credentials.filter((c) => !c.disabled).map((c) => c.plan?.label ?? 'Plan unknown'))].join(' + ');
  return { provider: () => pool().provider, summary, rate, past, projection, drain, segments, resetAt, plans };
}

export type PoolModel = ReturnType<typeof createPoolModel>;

/** A provider's pool in one window length: a card line, and a chart line when its length is chosen. */
export interface PoolLine {
  /** Window length in ms, as `durationChoices` values it. */
  ms: string;
  label: () => string;
  model: PoolModel;
}

export interface ProviderPool {
  id: string;
  count: () => number;
  /** Lengths this provider has data for. */
  lines: () => PoolLine[];
}

/** One model per provider and window length. Mapped by value, so each poll updates models in place. */
export function createProviderPools(ids: () => string[], credsOf: (id: string) => Credential[], lengths: () => WindowChoice[], strategy: () => string) {
  const values = createMemo(() => lengths().map((l) => l.value));
  return mapArray(ids, (id): ProviderPool => {
    const pool = () => ({ provider: id, credentials: credsOf(id) });
    const all = mapArray(values, (ms) => ({
      ms,
      label: () => lengths().find((l) => l.value === ms)?.label ?? '',
      model: createPoolModel(pool, () => keyForDuration(credsOf(id), Number(ms)), strategy),
    }));
    return { id, count: () => credsOf(id).length, lines: () => all().filter((l) => l.model.summary()) };
  });
}
