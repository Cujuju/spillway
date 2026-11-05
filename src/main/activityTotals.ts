import { addCounts, addEvent, emptyCounts, localDay, localHourStart } from '@shared/activityCounts';
import type { ActivityBucket, ActivityDayTotal, ActivityEvent } from '@shared/types';
import type { Db } from './activityDb';

/** Legacy keys omit the client segment when no client was recorded. */
type Dimensions = Pick<ActivityDayTotal, 'provider' | 'authIndex' | 'model' | 'client' | 'source' | 'effectiveModel' | 'reasoningEffort'>;
const effortKey = (t: Dimensions): string => t.effectiveModel || t.reasoningEffort ? `|metadata:${JSON.stringify([t.effectiveModel ?? null, t.reasoningEffort ?? null])}` : '';
export const totalKey = (t: Dimensions & { day: string }) =>
  `${t.day}|${t.provider}|${t.authIndex ?? ''}|${t.model}${t.client == null ? '' : `|${t.client}`}${t.source === 'client-log' ? '|client-log' : ''}${effortKey(t)}`;

/** Missing start identifies a legacy daily baseline, never an hourly row. */
export type ActivityTotal = ActivityDayTotal & { start?: number };

export function storedTotalKey(t: Dimensions & { day: string; start?: number }): string {
  return t.start === undefined ? totalKey(t) : JSON.stringify([t.start, t.provider, t.authIndex, t.model, t.client, t.source ?? 'proxy']) + effortKey(t);
}

export function addToTotals(totals: Map<string, ActivityTotal>, e: ActivityEvent): ActivityTotal {
  const base = { day: localDay(Date.parse(e.at)), start: localHourStart(Date.parse(e.at)), provider: e.provider,
    authIndex: e.authIndex, model: e.model, client: e.client ?? null, source: e.source ?? 'proxy',
    ...(e.effectiveModel ? { effectiveModel: e.effectiveModel } : {}), ...(e.reasoningEffort ? { reasoningEffort: e.reasoningEffort } : {}) };
  const key = storedTotalKey(base);
  const row = totals.get(key) ?? { ...base, ...emptyCounts() };
  addEvent(row, e);
  totals.set(key, row);
  return row;
}

export function readTotalRows(db: Db): { key: string; total: ActivityTotal }[] {
  const rows = db.prepare('SELECT key, total FROM activity_totals').all() as { key: string; total: string }[];
  return rows.map((r) => {
    const t = JSON.parse(r.total) as ActivityTotal;
    return { key: r.key, total: { ...emptyCounts(), ...t, client: t.client ?? null, source: t.source ?? 'proxy' as const } };
  });
}

export function readTotals(db: Db): Map<string, ActivityTotal> {
  return new Map(readTotalRows(db).map(({ total }) => [storedTotalKey(total), total]));
}

/** Daily consumers sum disjoint legacy baselines and newly recorded hours. */
export function dailyTotals(totals: Iterable<ActivityTotal>): ActivityDayTotal[] {
  const days = new Map<string, ActivityDayTotal>();
  for (const { start: _, ...t } of totals) {
    const key = totalKey(t);
    const row = days.get(key) ?? { ...t, ...emptyCounts() };
    addCounts(row, t);
    days.set(key, row);
  }
  return [...days.values()];
}

export function toBucket({ day, start, ...t }: ActivityTotal): ActivityBucket {
  const [y, m, d] = day.split('-').map(Number);
  return { ...t, start: start ?? new Date(y!, m! - 1, d!).getTime(), wholeDay: start === undefined };
}
