import { createMemo, mapArray } from 'solid-js';
import type { Credential } from '@shared/types';
import { poolSummary, project } from '../lib/forecast';
import { poolShares } from '../lib/poolCapacity';
import { drainRatePerHour, drainSeries, pastSeries } from '../lib/poolHistory';
import { keyForDuration, lengthLineId, nextResetAt, poolSegments, scopedChoices, scopedLineId, type WindowChoice } from '../lib/poolWindows';
import { activityBuckets, history, now, settings } from '../store';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Chart lines carry every stored sample, so zooming out reaches past the lookback. */
const WHOLE_HISTORY = Number.NEGATIVE_INFINITY;

export interface PoolInput {
  provider: string;
  credentials: Credential[];
}

/** Default chart span shared by every pool on one panel: lookback behind now, forecast ahead. */
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
    return [...pastSeries(history(), pool().credentials, k, WHOLE_HISTORY, shares()), { t: now(), remaining: s.remaining }];
  });
  const projection = createMemo(() =>
    key() ? project(pool().credentials, key()!, rate() ?? 0, now(), settings().dashboard.forecastDays, strategy(), shares()) : null,
  );
  const drain = createMemo(() => (key() ? drainSeries(history(), shares(), key()!, WHOLE_HISTORY) : []));
  const segments = createMemo(() => (key() ? poolSegments(pool().credentials, key()!, shares()) : []));
  const resetAt = () => (key() ? nextResetAt(pool().credentials, key()!, now()) : null);
  const plans = () => [...new Set(pool().credentials.filter((c) => !c.disabled && !c.apiKey).map((c) => c.plan?.label ?? 'Plan unknown'))].join(' + ');
  return { provider: () => pool().provider, summary, rate, past, projection, drain, segments, resetAt, plans };
}

export type PoolModel = ReturnType<typeof createPoolModel>;

/** A provider's pool in one window: a card line, and a chart line when its id is chosen. */
export interface PoolLine {
  /** `lengthLineId` or `scopedLineId`; lines sharing an id chart together. */
  id: string;
  /** Model, feature or spend window; the card folds these away. */
  scoped: boolean;
  label: () => string;
  model: PoolModel;
}

export interface ProviderPool {
  id: string;
  count: () => number;
  /** Every credential is an API key; keys report no limits, so the pool never has windows. */
  keysOnly: () => boolean;
  /** Windows this provider has data for: account-wide by length, then scoped. */
  lines: () => PoolLine[];
}

/** One model per provider and window. Mapped by value, so each poll updates models in place. */
export function createProviderPools(ids: () => string[], credsOf: (id: string) => Credential[], lengths: () => WindowChoice[], strategy: () => string) {
  const values = createMemo(() => lengths().map((l) => l.value));
  return mapArray(ids, (id): ProviderPool => {
    const pool = () => ({ provider: id, credentials: credsOf(id) });
    const scoped = createMemo(() => scopedChoices(credsOf(id)));
    const scopedKeys = createMemo(() => scoped().map((s) => s.value));
    const byLength = mapArray(values, (ms): PoolLine => ({
      id: lengthLineId(ms),
      scoped: false,
      label: () => lengths().find((l) => l.value === ms)?.label ?? '',
      model: createPoolModel(pool, () => keyForDuration(credsOf(id), Number(ms)), strategy),
    }));
    const byKey = mapArray(scopedKeys, (key): PoolLine => ({
      id: scopedLineId(key),
      scoped: true,
      label: () => scoped().find((s) => s.value === key)?.label ?? key,
      model: createPoolModel(pool, () => key, strategy),
    }));
    return { id, count: () => credsOf(id).length, keysOnly: () => credsOf(id).every((c) => c.apiKey), lines: () => [...byLength(), ...byKey()].filter((l) => l.model.summary()) };
  });
}
