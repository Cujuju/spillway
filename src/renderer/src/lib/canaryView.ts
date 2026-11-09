import { CANARY_PROBES, type CanaryResult, type CanaryTarget } from '@shared/canary';
import { dayText, shiftDay } from './activityRange';

/** One colour per target, CANARY_MAX_TARGETS of them, distinct in both themes. */
export const CANARY_COLORS = ['var(--color-accent)', 'var(--color-amber)', 'var(--color-green)', 'var(--provider-claude)'] as const;

export const targetKey = (t: CanaryTarget) => `${t.model}|${t.effort}`;
export const targetLabel = (t: CanaryTarget) => `${t.model} · ${t.effort}`;

/** Every local day from..to inclusive. */
export function rangeDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) days.push(d);
  return days;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Configured targets first, then retired ones that still have results in range. */
export function canaryTargets(configured: CanaryTarget[], results: CanaryResult[]): CanaryTarget[] {
  const seen = new Map(configured.map((t) => [targetKey(t), t]));
  for (const r of results) if (!seen.has(targetKey(r))) seen.set(targetKey(r), { model: r.model, effort: r.effort });
  return [...seen.values()];
}

export interface TargetDaily { key: string; label: string; color: string; passRate: (number | null)[]; thinking: (number | null)[] }

/** Pass rate excludes errors (no answer to grade); thinking averages results that reported a count. */
export function canaryDaily(results: CanaryResult[], days: string[], targets: CanaryTarget[]): TargetDaily[] {
  const index = new Map(days.map((d, i) => [d, i]));
  return targets.map((t, k) => {
    const graded = days.map(() => ({ pass: 0, total: 0, thinking: [] as number[] }));
    for (const r of results) {
      const i = index.get(dayText(Date.parse(r.at)));
      if (i === undefined || targetKey(r) !== targetKey(t)) continue;
      if (r.outcome !== 'error') { graded[i]!.total++; if (r.outcome === 'pass') graded[i]!.pass++; }
      if (r.thinkingTokens !== null) graded[i]!.thinking.push(r.thinkingTokens);
    }
    return {
      key: targetKey(t), label: targetLabel(t), color: CANARY_COLORS[k % CANARY_COLORS.length]!,
      passRate: graded.map((g) => (g.total ? g.pass / g.total : null)),
      thinking: graded.map((g) => mean(g.thinking)),
    };
  });
}

export interface BatchCell { outcome: CanaryResult['outcome'] | null; result: CanaryResult | null }
export interface LatestBatch { at: string; targets: CanaryTarget[]; probes: { id: string; title: string; cells: BatchCell[] }[]; passed: number; graded: number; errors: number }

/** The newest batch as a probe × target grid. */
export function latestBatch(results: CanaryResult[]): LatestBatch | null {
  const newest = results.reduce<CanaryResult | null>((a, r) => (!a || r.at > a.at ? r : a), null);
  if (!newest) return null;
  const batch = results.filter((r) => r.batchId === newest.batchId);
  const targets = canaryTargets([], batch);
  const probeIds = [...new Set([...CANARY_PROBES.map((p) => p.id), ...batch.map((r) => r.probeId)])].filter((id) => batch.some((r) => r.probeId === id));
  const title = (id: string) => CANARY_PROBES.find((p) => p.id === id)?.title ?? id;
  const probes = probeIds.map((id) => ({
    id, title: title(id),
    cells: targets.map((t) => { const result = batch.find((r) => r.probeId === id && targetKey(r) === targetKey(t)) ?? null; return { outcome: result?.outcome ?? null, result }; }),
  }));
  return {
    at: batch.reduce((a, r) => (r.at < a ? r.at : a), newest.at), targets, probes,
    passed: batch.filter((r) => r.outcome === 'pass').length,
    graded: batch.filter((r) => r.outcome !== 'error').length,
    errors: batch.filter((r) => r.outcome === 'error').length,
  };
}
