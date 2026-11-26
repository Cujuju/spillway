import { createResource, type Accessor } from 'solid-js';
import type { ActivityScope } from '@shared/activityScope';
import { settingKey, type Alternative, type SettingReport, type ThinkingQuery, type ThinkingReport, type ThinkingSetting, type TurnKind } from '@shared/thinking';
import { createReportQuery } from './reportRefresh';
import type { Span } from './activityRange';
import { modelName } from './comboSelection';

const DAYS_PER_WEEK = 7;
const PERCENT = 100;

/** The Thinking tab's latest resolved report and the exact query that produced it. Undefined until answered; null on failure. */
export function createThinkingReport(active: Accessor<boolean>, scope: Accessor<ActivityScope>, span: Accessor<Span>, rangeKey: Accessor<string>): { report: Accessor<ThinkingReport | null | undefined>; query: Accessor<ThinkingQuery | false> } {
  const query = createReportQuery<{ scope: ActivityScope; rangeKey: string }, ThinkingQuery>(
    active,
    // Effort is what the tab compares, so the scope's effort filter never narrows it.
    () => ({ scope: { ...scope(), efforts: null }, rangeKey: rangeKey() }),
    ({ scope }) => ({ scope, from: span().from, to: span().to }),
  );
  const [resolved] = createResource(
    query,
    (q) => window.api.activityThinking(q)
      .then((report) => ({ report, query: q }))
      .catch((err: unknown) => {
        console.error('[activity] thinking report failed:', err);
        return { report: null as ThinkingReport | null, query: q };
      }),
  );
  return { report: () => resolved.latest?.report, query: () => resolved.latest?.query ?? false };
}

/** "Opus 5.5 · high". */
export const settingName = (s: ThinkingSetting): string => `${modelName(s.model)} · ${s.effort}`;

/** A covered-days figure as a weekly one. */
export const perWeek = (report: ThinkingReport, v: number): number => (report.coveredDays > 0 ? (v * DAYS_PER_WEEK) / report.coveredDays : 0);

/** 0..1 as "41%". */
export const share = (v: number): string => `${Math.round(v * PERCENT)}%`;

export const KIND_TEXT: Record<TurnKind, { name: string; rule: string }> = {
  question: { name: 'Quick question', rule: '1 to 2 requests' },
  change: { name: 'Small change', rule: '3 to 15 requests' },
  long: { name: 'Long task', rule: 'more than 15 requests, or uses subagents' },
};

/** The setting By kind and Alternatives show: the chosen one when in range, else the costliest. */
export function chosenSetting(report: ThinkingReport, chosen: string | null): SettingReport | undefined {
  return report.settings.find((s) => settingKey(s.setting) === chosen) ?? report.settings[0];
}

const isLowerEffort = (a: Alternative) => a.method === 'effort-ratio';
/** The next lower effort: the first one listed, with or without an estimate. */
export const lowerEffort = (s: SettingReport): Alternative | undefined => s.alternatives.find(isLowerEffort);
/** The highest lower effort that has an estimate; KindStat savings use it. */
export const estimatedLowerEffort = (s: SettingReport): Alternative | undefined => s.alternatives.find((a) => isLowerEffort(a) && a.savingUsdPerWeek !== null);
/** The closest cheaper model at this effort. */
export const cheaperModel = (s: SettingReport): Alternative | undefined => s.alternatives.find((a) => a.method === 'reprice');
export const mixedOption = (s: SettingReport): Alternative | undefined => s.alternatives.find((a) => a.method === 'mixed');

/** An alternative's row name. The mixed option names both efforts. */
export function alternativeName(s: SettingReport, a: Alternative): string {
  if (a.method !== 'mixed') return settingName(a.setting);
  const lower = a.setting.effort;
  return `${lower[0]!.toUpperCase()}${lower.slice(1)}, but ${s.setting.effort} for long tasks`;
}

/** How an alternative's figures are worked out, or why there are none. */
export function alternativeMethod(s: SettingReport, a: Alternative): string {
  if (a.reason === 'not-enough-data') return `Not enough of your own turns at ${a.setting.effort} yet.`;
  if (a.reason === 'unpriced') return `No list price for ${modelName(a.setting.model)}.`;
  if (a.method === 'effort-ratio') return `Thinking scaled by how your own turns think at ${a.setting.effort}.`;
  if (a.method === 'mixed') return `${a.setting.effort[0]!.toUpperCase()}${a.setting.effort.slice(1)} for quick questions and small changes only; long tasks stay at ${s.setting.effort}.`;
  return `Same tokens at ${modelName(a.setting.model)} list prices.`;
}
