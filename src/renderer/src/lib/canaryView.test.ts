import { describe, expect, it } from 'vitest';
import type { CanaryResult } from '@shared/canary';
import { canaryDaily, canaryTargets, latestBatch, rangeDays } from './canaryView';

// Local noon, so the local day never depends on the test machine's zone.
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).toISOString();
const result = (patch: Partial<CanaryResult>): CanaryResult => ({
  id: crypto.randomUUID(), batchId: 'b1', at: at(5), model: 'claude-opus-5-5', effort: 'high', effectiveModel: null,
  probeId: 'p1', probeVersion: 1, outcome: 'pass', answer: '42', error: null, outputTokens: 500, thinkingTokens: 300, latencyMs: 4000, ...patch,
});

describe('rangeDays', () => {
  it('lists every day inclusive', () => {
    expect(rangeDays('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('canaryTargets', () => {
  it('keeps configured order and adds retired targets with results', () => {
    const t = canaryTargets([{ model: 'a', effort: 'high' }], [result({ model: 'b', effort: 'low' }), result({ model: 'a', effort: 'high' })]);
    expect(t).toEqual([{ model: 'a', effort: 'high' }, { model: 'b', effort: 'low' }]);
  });
});

describe('canaryDaily', () => {
  it('leaves errors out of the pass rate and averages known thinking', () => {
    const days = rangeDays('2026-11-04', '2026-11-06');
    const rows = canaryDaily([
      result({ outcome: 'pass', thinkingTokens: 200 }),
      result({ outcome: 'fail', thinkingTokens: 400 }),
      result({ outcome: 'error', thinkingTokens: null }),
    ], days, [{ model: 'claude-opus-5-5', effort: 'high' }]);
    expect(rows[0]!.passRate).toEqual([null, 0.5, null]);
    expect(rows[0]!.thinking).toEqual([null, 300, null]);
  });
});

describe('latestBatch', () => {
  it('grids the newest batch by probe and target', () => {
    const b = latestBatch([
      result({ batchId: 'old', at: at(4) }),
      result({ batchId: 'new', at: at(5, 9), probeId: 'p1' }),
      result({ batchId: 'new', at: at(5, 10), probeId: 'p2', outcome: 'error', error: 'timeout' }),
    ])!;
    expect(b.probes.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(b.passed).toBe(1);
    expect(b.graded).toBe(1);
    expect(b.errors).toBe(1);
    expect(b.at).toBe(at(5, 9));
  });

  it('is null without results', () => {
    expect(latestBatch([])).toBeNull();
  });
});
