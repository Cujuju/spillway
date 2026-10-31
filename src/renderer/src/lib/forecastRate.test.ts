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
  const rate = (summaries: WindowSummary[], history = samples) => forecastRate(history, summaries, credentials, KEY, shares, NOW);
  const projection = (summaries: WindowSummary[]) => project(credentials, KEY, rate(summaries) ?? 0, NOW, 1, 'fill-first', shares);
  return { rate, projection, summary, credentials, samples };
}

describe('forecastRate', () => {
  it('R1: a real burst overrides quiet finished windows', () => {
    const f = fixture(5 * H, H / 6, 40);
    const p = f.projection([f.summary(48), f.summary(52)]);
    expect(p.accounts.get('a')?.runsOutAt).toBeGreaterThan(NOW);
    expect(p.accounts.get('a')?.runsOutAt).toBeLessThan(NOW + 5 * H - H / 6);
    expect(p.accounts.get('a')?.runsOutAt).toBe(p.stuck?.at);
  });
  it('R2: tiny early weekly use stays near the historical pace', () => {
    const f = fixture(168 * H, H / 4, 1);
    const forecast = f.projection([f.summary(58), f.summary(62)]).accounts.get('a')!;
    expect(forecast.runsOutAt).toBeNull();
    expect(forecast.endsAtPercent).toBeLessThan(75);
  });
  it('R3: falls back to recent history alone, or null without history', () => {
    const f = fixture(5 * H, H / 6, 40);
    expect(f.rate([])).toBeCloseTo(240);
    expect(f.rate([f.summary(50)], [])).toBeNull();
  });
  it('uses shares to express account rates as pool percent per hour', () => {
    const f = fixture(5 * H, H / 6, 40);
    expect(forecastRate(f.samples, [], f.credentials, KEY, new Map([['a', { share: 0.25, cost: { [KEY]: 4 } }]]), NOW)).toBeCloseTo(60);
  });
  it('excludes unfinished summaries from the baseline', () => {
    const f = fixture(5 * H, H / 6, 40);
    expect(f.rate([{ ...f.summary(1), resetAt: NOW + H }])).toBeCloseTo(240);
  });
});
