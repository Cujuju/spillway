import type { Db } from './activityDb';
import { DAY_KEY } from './activityDb';
import { scopeClause } from './activityStore';
import { normalizeScope } from '@shared/activityScope';
import { localDay } from '@shared/activityCounts';
import { diffRequestSettings, type RequestSettings } from '@shared/requestSettings';
import type { DriftQuery, DriftReport, DriftDay, DriftSeries } from '@shared/drift';
import type { CanaryResult } from '@shared/canary';
/** A week captures the version in use before the requested range. */
export const DRIFT_CHANGE_LOOKBACK_DAYS = 7;
/** Tiny result rows permit a year of comparable baselines. */
export const CANARY_RETENTION_DAYS = 365;
function validate(q: { from: string; to: string }) {
  if ([q.from, q.to].some((day) => typeof day !== 'string' || !DAY_KEY.test(day) || !Number.isFinite(Date.parse(`${day}T12:00:00`)) || localDay(Date.parse(`${day}T12:00:00`)) !== day) || q.from > q.to) throw new Error('Invalid day range');
}
export function queryDrift(db: Db, q: DriftQuery): DriftReport {
  validate(q);
  const days: string[] = [];
  const cursor = new Date(`${q.from}T12:00:00`);
  while (localDay(cursor.getTime()) <= q.to) { days.push(localDay(cursor.getTime())); cursor.setDate(cursor.getDate() + 1); }
  const clause = scopeClause(normalizeScope(q.scope));
  const scopeSql = clause ? `AND ${clause.sql}` : '';
  const params = clause?.params ?? [];
  const dimensions = `json_extract(event, '$.provider') AS provider,
    coalesce(json_extract(event, '$.effectiveModel'), json_extract(event, '$.model')) AS model,
    json_extract(event, '$.reasoningEffort') AS effort`;
  const ok = "NOT coalesce(json_extract(event, '$.failed'), 0)";
  const timing = `${ok} AND coalesce(json_extract(event, '$.source'), 'proxy') != 'client-log'`;
  const sum = (condition: string, field?: string) => `sum(CASE WHEN ${condition} THEN ${field ? `coalesce(json_extract(event, '$.${field}'), 0)` : '1'} ELSE 0 END)`;
  const rows = db.prepare(`SELECT day, ${dimensions},
    ${sum(ok)} AS replies, ${sum(`NOT (${ok})`)} AS failed,
    ${sum(ok, 'outputTokens')} AS outputTokens, ${sum(ok, 'thinkingTokens')} AS thinkingTokens,
    ${sum(`${ok} AND json_extract(event, '$.thinkingTokens') IS NOT NULL`)} AS thinkingKnown,
    ${sum(`${ok} AND json_extract(event, '$.thinkingTokens') = 0`)} AS noThinking,
    ${sum(timing, 'ttftMs')} AS ttftSumMs,
    ${sum(`${timing} AND json_extract(event, '$.ttftMs') IS NOT NULL`)} AS ttftCount,
    ${sum(timing, 'latencyMs')} AS latencySumMs,
    ${sum(`${timing} AND json_extract(event, '$.latencyMs') IS NOT NULL`)} AS latencyCount
    FROM requests WHERE day BETWEEN ? AND ? ${scopeSql}
    GROUP BY day, provider, model, effort`).all(q.from, q.to, ...params) as (DriftDay & { provider: string; model: string; effort: string | null })[];
  const groups = new Map<string, DriftSeries>();
  for (const row of rows) {
    const key = JSON.stringify([row.provider, row.model, row.effort]);
    let series = groups.get(key);
    if (!series) {
      series = { key, provider: row.provider, model: row.model, effort: row.effort, replies: 0,
        days: days.map((day) => ({ day, replies: 0, failed: 0, outputTokens: 0, thinkingTokens: 0, thinkingKnown: 0, noThinking: 0, ttftSumMs: 0, ttftCount: 0, latencySumMs: 0, latencyCount: 0 })), changes: [] };
      groups.set(key, series);
    }
    const { provider: _provider, model: _model, effort: _effort, ...stats } = row;
    Object.assign(series.days[days.indexOf(row.day)]!, stats);
    series.replies += row.replies;
  }
  const cutoff = new Date(`${q.from}T12:00:00`);
  cutoff.setDate(cutoff.getDate() - DRIFT_CHANGE_LOOKBACK_DAYS);
  const settingsCache = new Map<string, RequestSettings | null>();
  const readSettings = db.prepare('SELECT settings FROM request_settings WHERE hash = ?');
  const settings = (hash: string | null): RequestSettings | null => {
    if (!hash) return null;
    if (!settingsCache.has(hash)) {
      const row = readSettings.get(hash) as { settings: string } | undefined;
      settingsCache.set(hash, row ? JSON.parse(row.settings) : null);
    }
    return settingsCache.get(hash)!;
  };
  for (const [kind, field] of [['client-version', 'clientVersion'], ['settings', 'settingsHash']] as const) {
    const changes = db.prepare(`WITH values_in_range AS (
      SELECT id, day, ${dimensions}, json_extract(event, '$.at') AS at,
        json_extract(event, '$.client') AS client, json_extract(event, '$.${field}') AS value
      FROM requests WHERE day BETWEEN ? AND ? ${scopeSql} AND json_extract(event, '$.${field}') IS NOT NULL
    ), transitions AS (
      SELECT *, lag(value) OVER (PARTITION BY provider, model, effort, client ORDER BY at, id) AS previous FROM values_in_range
    ) SELECT * FROM transitions WHERE day >= ? AND previous IS NOT NULL AND value IS NOT previous ORDER BY at, id`)
      .all(localDay(cutoff.getTime()), q.to, ...params, q.from) as { day: string; at: string; provider: string; model: string; effort: string | null; client: string | null; value: string; previous: string | null }[];
    for (const row of changes) {
      const series = groups.get(JSON.stringify([row.provider, row.model, row.effort]));
      const next = kind === 'settings' ? settings(row.value) : null;
      series?.changes.push({ at: row.at, day: row.day, kind, client: row.client, from: row.previous, to: row.value,
        details: next ? diffRequestSettings(settings(row.previous), next) : [] });
    }
  }
  for (const series of groups.values()) series.changes.sort((a, b) => a.at.localeCompare(b.at));
  const retained = db.prepare('SELECT min(day) AS day FROM requests').get() as { day: string | null };
  return { from: q.from, to: q.to, retainedFrom: retained.day, series: [...groups.values()].filter((s) => s.days.some((d) => d.replies + d.failed > 0)).sort((a, b) => b.replies - a.replies) };
}
export function storeCanaryResults(db: Db, results: CanaryResult[]): void {
  db.transaction(() => {
    const insert = db.prepare('INSERT OR REPLACE INTO canary_results VALUES (?, ?, ?)');
    for (const r of results) insert.run(r.id, localDay(Date.parse(r.at)), JSON.stringify(r));
    pruneCanaries(db);
  })();
}
function pruneCanaries(db: Db): void {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - CANARY_RETENTION_DAYS);
  db.prepare('DELETE FROM canary_results WHERE day < ?').run(localDay(cutoff.getTime()));
}
export function queryCanaryResults(db: Db, q: { from: string; to: string }): CanaryResult[] {
  validate(q);
  pruneCanaries(db);
  return (db.prepare('SELECT result FROM canary_results WHERE day BETWEEN ? AND ? ORDER BY day, id').all(q.from, q.to) as { result: string }[]).map((r) => JSON.parse(r.result));
}
