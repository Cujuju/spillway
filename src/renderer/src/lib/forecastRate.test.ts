import { describe, expect, it } from 'vitest';
import type { Credential, HistorySample, WindowSummary } from '@shared/types';
import { forecastRate } from './forecastRate';
import { project } from './forecast';

const H = 3_600_000;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const KEY = 'window';
const shares = new Map([['a', { share: 1, cost: { [KEY]: 1 } }]]);
const iso = (t: number) => new Date(t).toISOString();
function fixture(duration: number, elapsed: number, used: number) {
  const credentials = [{
    id: 'a', priority: 0, weight: 1, preferred: false, cooldownUntil: null,
    windows: [{ key: KEY, usedPercent: used, resetsAt: iso(NOW + duration - elapsed), durationMs: duration, resetCadence: 'on_use', scoped: false }],
  }] as Credential[];
  const samples: HistorySample[] = [{ at: iso(NOW - elapsed), used: { a: { [KEY]: 0 } } }, { at: iso(NOW), used: { a: { [KEY]: used } } }];
  const summary = (peak: number): WindowSummary => ({
    credentialId: 'a', key: KEY, resetAt: NOW - elapsed, endedAt: null, peak, exhaustedAt: null,
    firstSampleAt: NOW - elapsed - duration, lastSampleAt: NOW - elapsed,
  });
  const rate = (summaries: WindowSummary[], history: HistorySample[] = []) => forecastRate(history, summaries, credentials, KEY, shares, NOW, 24);
  const projection = (summaries: WindowSummary[], history: HistorySample[] = []) => project(credentials, KEY, rate(summaries, history) ?? 0, NOW, 1, 'fill-first', shares);
  return { rate, projection, summary, credentials, samples };
}

describe('forecastRate', () => {
  it('T1: weekly use still forecasts drain without samples in the last hour', () => {
    const f = fixture(168 * H, 26 * H, 6);
    const history = [{ at: iso(NOW - 2 * H), used: { a: { [KEY]: 6 } } }];
    expect(f.rate([], history)).toBeCloseTo(6 / 26);
    const forecast = f.projection([], history).accounts.get('a')!;
    expect(forecast.runsOutAt).toBeNull();
    expect(100 - forecast.endsAtPercent).toBeLessThan(70);
  });
  it('T2: a real burst overrides quiet finished windows', () => {
    const f = fixture(5 * H, H / 6, 40);
    const p = f.projection([f.summary(48), f.summary(52)]);
    expect(p.accounts.get('a')?.runsOutAt).toBeGreaterThan(NOW);
    expect(p.accounts.get('a')?.runsOutAt).toBeLessThan(NOW + 5 * H - H / 6);
    expect(p.accounts.get('a')?.runsOutAt).toBe(p.stuck?.at);
  });
  it('T3: tiny early weekly use stays near the historical pace', () => {
    const f = fixture(168 * H, H / 4, 1);
    const forecast = f.projection([f.summary(58), f.summary(62)]).accounts.get('a')!;
    expect(forecast.runsOutAt).toBeNull();
    expect(forecast.endsAtPercent).toBeGreaterThan(50);
    expect(forecast.endsAtPercent).toBeLessThan(75);
  });
  it('T4: an idle on-use window without a reset or prior contributes zero', () => {
    const f = fixture(5 * H, 0, 0);
    f.credentials[0]!.windows[0]!.resetsAt = null;
    expect(f.rate([])).toBe(0);
  });
  it('uses the current window without any history', () => {
    const f = fixture(5 * H, H / 6, 40);
    expect(f.rate([])).toBeCloseTo(240);
    expect(f.rate([f.summary(50)])).toBeCloseTo((40 + 10 * 0.5) / (1 / 6 + 0.5));
  });
  it('uses shares to express account rates as pool percent per hour', () => {
    const f = fixture(5 * H, H / 6, 40);
    expect(forecastRate([], [], f.credentials, KEY, new Map([['a', { share: 0.25, cost: { [KEY]: 4 } }]]), NOW, 24)).toBeCloseTo(60);
  });
  it('excludes unfinished summaries from the baseline', () => {
    const f = fixture(5 * H, H / 6, 40);
    expect(f.rate([{ ...f.summary(1), resetAt: NOW + H }])).toBeCloseTo(240);
  });
  it('uses dashboard lookback consumption as the prior when no finished window exists', () => {
    const f = fixture(5 * H, H / 6, 40);
    const history = [
      { at: iso(NOW - 48 * H), used: { a: { [KEY]: 0 } } },
      { at: iso(NOW - 4 * H), used: { a: { [KEY]: 10 } } },
      { at: iso(NOW - 2 * H), used: { a: { [KEY]: 20 } } },
      { at: iso(NOW + H), used: { a: { [KEY]: 100 } } },
    ];
    expect(f.rate([], history)).toBeCloseTo((40 + 5 * 0.5) / (1 / 6 + 0.5));
    expect(f.rate([f.summary(50)], history)).toBeCloseTo((40 + 10 * 0.5) / (1 / 6 + 0.5));
  });
  it('counts consumption across resets in the history prior', () => {
    const f = fixture(5 * H, H / 6, 40);
    const history = [
      { at: iso(NOW - 4 * H), used: { a: { [KEY]: 80 } }, resets: { a: { [KEY]: NOW - 3 * H } } },
      { at: iso(NOW - 2 * H), used: { a: { [KEY]: 20 } } },
    ];
    expect(f.rate([], history)).toBeCloseTo((40 + 10 * 0.5) / (1 / 6 + 0.5));
  });
  it.each(['reset', 'duration', 'usage', 'elapsed'])("uses the prior alone without valid current %s", (missing) => {
    const f = fixture(5 * H, H / 6, 40);
    const window = f.credentials[0]!.windows[0]!;
    if (missing === 'reset') window.resetsAt = null;
    if (missing === 'duration') window.durationMs = null;
    if (missing === 'usage') window.usedPercent = null;
    if (missing === 'elapsed') window.resetsAt = iso(NOW + 5 * H);
    expect(f.rate([], f.samples)).toBeCloseTo(240);
  });
  it('uses finished windows alone when the current window has no reset', () => {
    const f = fixture(5 * H, H / 6, 0);
    f.credentials[0]!.windows[0]!.resetsAt = null;
    expect(f.rate([f.summary(50)])).toBeCloseTo(10);
  });
  it('returns null only when no account has usage or prior evidence', () => {
    const f = fixture(5 * H, H / 6, 0);
    expect(f.rate([])).toBe(0);
    f.credentials[0]!.windows[0]!.usedPercent = null;
    expect(f.rate([])).toBeNull();
    expect(f.rate([f.summary(0)])).toBe(0);
  });
});
