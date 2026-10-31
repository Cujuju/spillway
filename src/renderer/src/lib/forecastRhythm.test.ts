import { describe, expect, it } from 'vitest';
import type { Credential, HistorySample, WindowSummary } from '@shared/types';
import { project } from './forecast';
import { forecastRate } from './forecastRate';
import { FLAT_RHYTHM } from './rhythmProfile';

const H = 3_600_000;
const NOW = Date.parse('2026-10-25T00:00:00Z');
const utc = () => 0;
const iso = (t: number) => new Date(t).toISOString();
const shares = new Map([['a', { share: 1, cost: { week: 1, session: 1 } }]]);
function credential(key: string, used: number, reset: number | null, duration: number): Credential {
  return {
    id: 'a', name: 'a', authIndex: 'a', provider: 'claude', label: 'a', note: null, email: null,
    lastUsedAt: null, disabled: false, status: 'active', statusMessage: null, priority: 0,
    cooldownUntil: null, observedAt: null, nextPick: false, preferred: false, weight: 1, plan: null, resetCredits: null,
    windows: [{ key, label: key, usedPercent: used, resetsAt: reset === null ? null : iso(reset), durationMs: duration,
      status: 'allowed', scoped: false, resetCadence: 'on_use' }],
  };
}
// Eight working hours carry almost all demand; the other sixteen retain a small floor.
const sessionProfile: number[] = Array.from({ length: 24 }, (_, h) => h >= 9 && h < 17 ? 2.9 : 0.05);

describe('rhythmic forecast', () => {
  it('delays overnight run-out, keeping single-account row and stuck times equal', () => {
    const c = credential('week', 50, NOW + 48 * H, 168 * H);
    const flat = project([c], 'week', 10, NOW, 24, 'fill-first', shares);
    const shaped = project([c], 'week', 10, NOW, 24, 'fill-first', shares, sessionProfile, utc);
    expect(flat.stuck?.at).toBe(NOW + 5 * H);
    expect(shaped.stuck!.at).toBeGreaterThan(NOW + 9 * H);
    expect(shaped.accounts.get('a')!.runsOutAt).toBe(shaped.stuck!.at);
    expect(shaped.points.map((p) => p.t)).toEqual(flat.points.map((p) => p.t));
  });
  it('fills a five-hour window inside the session and recovers at its reset', () => {
    const now = NOW + 9 * H;
    const c = credential('session', 0, null, 5 * H);
    const flat = project([c], 'session', 10, now, 8, 'fill-first', shares);
    const shaped = project([c], 'session', 10, now, 8, 'fill-first', shares, sessionProfile, utc);
    expect(flat.stuck).toBeNull();
    expect(shaped.stuck!.at).toBeCloseTo(now + 100 / 29 * H, 0);
    expect(shaped.stuck!.until).toBe(now + 5 * H);
    expect(shaped.accounts.get('a')!.runsOutAt).toBe(shaped.stuck!.at);
  });
  it('allows overnight refills before working demand returns', () => {
    const c = credential('week', 90, NOW + 4 * H, 168 * H);
    const shaped = project([c], 'week', 10, NOW, 12, 'fill-first', shares, sessionProfile, utc);
    expect(project([c], 'week', 10, NOW, 12, 'fill-first', shares).stuck?.at).toBe(NOW + H);
    expect(shaped.stuck).toBeNull();
    expect(shaped.nextReset?.at).toBe(NOW + 4 * H);
    expect(shaped.accounts.get('a')!.runsOutAt).toBeNull();
  });
  it('splits local hours independently of the fifteen-minute chart cadence', () => {
    const now = NOW + 8.9 * H;
    const c = credential('week', 50, now + 48 * H, 168 * H);
    const p = project([c], 'week', 10, now, 1, 'fill-first', shares, sessionProfile, utc);
    expect(p.points[1]!.remaining).toBeCloseTo(50 - 10 * (0.1 * 0.05 + 0.15 * 2.9));
  });
  it('explicit flat profile reproduces the default projection exactly', () => {
    const c = credential('week', 76, NOW + 4.1 * H, 168 * H);
    expect(project([c], 'week', 7, NOW, 24, 'fill-first', shares, FLAT_RHYTHM, utc))
      .toEqual(project([c], 'week', 7, NOW, 24, 'fill-first', shares));
  });
});

describe('rhythmic forecastRate', () => {
  const now = NOW + 10 * H;
  const c = credential('session', 29, NOW + 14 * H, 5 * H);
  const rate = (summaries: WindowSummary[] = [], samples: HistorySample[] = [], profile = sessionProfile) =>
    forecastRate(samples, summaries, [c], 'session', shares, now, 24, profile, utc);
  const summary: WindowSummary = {
    credentialId: 'a', key: 'session', resetAt: NOW - 10 * H, endedAt: null, peak: 58,
    exhaustedAt: NOW - 13 * H, firstSampleAt: NOW - 15 * H, lastSampleAt: NOW - 10 * H,
  };
  it('divides current use by weighted hours, avoiding double-counting a busy session', () => {
    expect(rate()).toBeCloseTo(10);
    expect(rate([], [], Array.from(FLAT_RHYTHM))).toBe(29);
    const p = project([c], 'session', rate()!, now, 5, 'fill-first', shares, sessionProfile, utc);
    expect(p.stuck!.at).toBeCloseTo(now + 71 / 29 * H, 0);
  });
  it('weights finished spans through exhaustion, rather than the full reset duration', () => {
    // Yesterday 09:00–11:00 spans 5.8 weighted hours: 58 / 5.8 = 10.
    expect(rate([summary])).toBeCloseTo(10);
  });
  it('weights lookback history when finished windows are absent', () => {
    const samples = [
      { at: iso(NOW - 15 * H), used: { a: { session: 0 } } },
      { at: iso(NOW - 13 * H), used: { a: { session: 58 } } },
    ];
    // Extend lookback to include yesterday's session.
    expect(forecastRate(samples, [], [c], 'session', shares, now, 48, sessionProfile, utc)).toBeCloseTo(10);
  });
  it('explicit flat profile gives exactly the default rate', () => {
    expect(rate([summary], [], Array.from(FLAT_RHYTHM)))
      .toBe(forecastRate([], [summary], [c], 'session', shares, now, 24));
  });
});
