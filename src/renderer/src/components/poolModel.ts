import { createMemo, createRoot, mapArray } from 'solid-js';
import type { Credential } from '@shared/types';
import { poolSummary, poolWindowKey, project } from '../lib/forecast';
import { sustainedForecastRate } from '../lib/forecastRate';
import { poolShares, preparePoolEvidence, type AccountShare } from '../lib/poolCapacity';
import { drainRatePerHour, drainSeries, pastSeries } from '../lib/poolHistory';
import { keyForDuration, lengthLineId, nextResetAt, poolSegments, scopedChoices, scopedLineId, type WindowChoice } from '../lib/poolWindows';
import { forecastAsOf, forecastBuckets, history, now, settings, windowSummaries } from '../store';
import { localHourStart, rhythmProfile, type RhythmProfile } from '../lib/rhythmProfile';

const HOUR_MS = 3_600_000;

/** Chart lines carry every stored sample, so zooming out reaches past the lookback. */
const WHOLE_HISTORY = Number.NEGATIVE_INFINITY;

/** Bounds the tray/shared poolShares cache across providers and window keys. */
const MAX_SHARES_CACHE = 32;

export interface PoolInput {
  provider: string;
  credentials: Credential[];
}

/** Shared across Dashboard pools and TrayIconSync so history/bucket indexing runs once per evidence change. */
const poolEvidence = createRoot(() => createMemo(() => preparePoolEvidence(history(), forecastBuckets(), forecastAsOf())));
/** Hourly buckets only change across local hour boundaries; coarsening avoids minute-tick rhythm recomputes. */
const currentHour = createRoot(() => createMemo(() => localHourStart(now())));

/** Fingerprint of credential fields that affect poolShares (enabled set, plans, window keys/durations). */
function shareInputsKey(credentials: Credential[], key: string): string {
  const active: unknown[] = [key];
  for (const c of credentials) {
    if (c.disabled) continue;
    let hasKey = false;
    const wins: [string, boolean, number | null][] = [];
    for (const w of c.windows) {
      if (w.key === key && w.usedPercent !== null) hasKey = true;
      wins.push([w.key, w.scoped, w.durationMs]);
    }
    if (!hasKey) continue;
    active.push([c.id, c.authIndex, c.plan ? [c.plan.tier, c.plan.multiplier] : null, wins]);
  }
  return JSON.stringify(active);
}

let cachedEvidence: ReturnType<typeof poolEvidence> | null = null;
const cachedShares = new Map<string, Map<string, AccountShare>>();

function sharedPoolShares(credentials: Credential[], key: string): Map<string, AccountShare> {
  const evidence = poolEvidence();
  if (cachedEvidence !== evidence) {
    cachedEvidence = evidence;
    cachedShares.clear();
  }
  const cacheKey = shareInputsKey(credentials, key);
  const hit = cachedShares.get(cacheKey);
  if (hit) return hit;
  const computed = poolShares(history(), credentials, key, forecastBuckets(), evidence);
  if (cachedShares.size >= MAX_SHARES_CACHE) cachedShares.clear();
  cachedShares.set(cacheKey, computed);
  return computed;
}

/** Default chart span shared by every pool on one panel: lookback behind now, forecast ahead. */
export const chartFrom = () => now() - settings().dashboard.drainLookbackHours * HOUR_MS;
export const chartTo = () => now() + settings().dashboard.forecastHours * HOUR_MS;

/** Percent of the pool left in `key` now, by the Dashboard's math; tray icons and the tray tooltip read it. */
export const poolRemaining = (credentials: Credential[], key: string) =>
  poolSummary(credentials, key, sharedPoolShares(credentials, key)).remaining;

/**
 * One provider's pool for window `key`: remaining, drain rate, history and projection.
 * Accounts weigh by plan size, so a Pro and a Max account add up by what they hold.
 */
export function createPoolModel(
  pool: () => PoolInput,
  key: () => string | null,
  strategy: () => string,
  sharedRhythm?: () => RhythmProfile,
) {
  let rhythm: () => RhythmProfile;
  if (sharedRhythm) {
    rhythm = sharedRhythm;
  } else {
    const localRhythm = createMemo(() => rhythmProfile(forecastBuckets(), pool().provider, currentHour()));
    rhythm = localRhythm;
  }
  const shares = createMemo(() => {
    const k = key();
    return k ? sharedPoolShares(pool().credentials, k) : new Map<string, AccountShare>();
  });
  const anchorKey = createMemo(() => poolWindowKey(pool().credentials));
  const anchorShares = createMemo(() => {
    const k = key();
    if (!k) return null;
    const ak = anchorKey();
    return ak && ak !== k ? sharedPoolShares(pool().credentials, ak) : null;
  });
  const summary = createMemo(() => (key() ? poolSummary(pool().credentials, key()!, shares()) : null));
  const rate = createMemo(() => (key() ? drainRatePerHour(history(), shares(), key()!, now(), settings().dashboard.drainLookbackHours) : null));
  const past = createMemo(() => {
    const k = key();
    const s = summary();
    if (!k || !s) return [];
    return [...pastSeries(history(), pool().credentials, k, WHOLE_HISTORY, shares()), { t: now(), remaining: s.remaining }];
  });
  const projection = createMemo(() =>
    key() ? project(pool().credentials, key()!, sustainedForecastRate(history(), windowSummaries(), pool().credentials, key()!, shares(), anchorKey(), anchorShares(), now(), settings().dashboard.drainLookbackHours, rhythm()) ?? 0, now(), settings().dashboard.forecastHours, strategy(), shares(), rhythm()) : null,
  );
  /** Computed lazily only when the Drain rate tab reads it, avoiding eager history scans on the Remaining tab. */
  const drain = () => (key() ? drainSeries(history(), shares(), key()!, WHOLE_HISTORY) : []);
  const segments = createMemo(() => (key() ? poolSegments(pool().credentials, key()!, shares()) : []));
  const resetAt = () => (key() ? nextResetAt(pool().credentials, key()!, now()) : null);
  const plans = () => [...new Set(pool().credentials.filter((c) => !c.disabled && !c.apiKey).map((c) => c.plan?.label ?? 'Plan unknown'))].join(' + ');
  /** Account forecasts for this window; null without a key. */
  const forecast = () => {
    const p = projection();
    return p ? { accounts: p.accounts } : null;
  };
  return {
    /** Window key this model projects. */
    key,
    forecast, provider: () => pool().provider, summary, rate, past, projection, drain, segments, resetAt, plans,
  };
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
    const rhythm = createMemo(() => rhythmProfile(forecastBuckets(), id, currentHour()));
    const scoped = createMemo(() => scopedChoices(credsOf(id)));
    const scopedKeys = createMemo(() => scoped().map((s) => s.value));
    const byLength = mapArray(values, (ms): PoolLine => ({
      id: lengthLineId(ms),
      scoped: false,
      label: () => lengths().find((l) => l.value === ms)?.label ?? '',
      model: createPoolModel(pool, () => keyForDuration(credsOf(id), Number(ms)), strategy, rhythm),
    }));
    const byKey = mapArray(scopedKeys, (key): PoolLine => ({
      id: scopedLineId(key),
      scoped: true,
      label: () => scoped().find((s) => s.value === key)?.label ?? key,
      model: createPoolModel(pool, () => key, strategy, rhythm),
    }));
    return { id, count: () => credsOf(id).length, keysOnly: () => credsOf(id).every((c) => c.apiKey), lines: () => [...byLength(), ...byKey()].filter((l) => l.model.summary()) };
  });
}
