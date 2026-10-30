import { describe, expect, it, vi } from 'vitest';
import type { UsageSnapshot } from '@shared/types';

vi.mock('./paths', () => ({ appPaths: { historyFile: 'unused', windowSummariesFile: 'unused-summaries', observedSpansFile: 'unused-spans' } }));
/** A 60 s refresh; stored samples are 5 min apart, so readings within 10 min count as watching. */
vi.mock('./settingsStore', () => ({ writeFileAtomic: () => undefined, getSettings: () => ({ dashboard: { refreshIntervalSeconds: 60 } }) }));

const { appendSample, history } = await import('./historyStore');

const sample = (at: string, used: number, reset?: string) => ({
  at, used: { a: { seven_day: used } }, resets: reset ? { a: { seven_day: Date.parse(reset) } } : undefined,
});
const times = (s: { at: string }[]) => s.map((x) => x.at.slice(11, 16));

/** A one-account snapshot; `used` null means the proxy has not looked the account up yet. */
const snapshot = (fetchedAt: string, used: number | null, resetsAt: string | null): UsageSnapshot => ({
  fetchedAt, strategy: 'round-robin',
  credentials: [{
    id: 'a', name: 'a', authIndex: 'a', provider: 'claude', label: 'a', note: null, email: null,
    lastUsedAt: null, disabled: false, status: 'ready', statusMessage: null, priority: 0,
    cooldownUntil: null, observedAt: null, nextPick: false, preferred: false, weight: 1, plan: null, resetCredits: null,
    windows: [{ key: 'seven_day', label: 'Weekly', usedPercent: used, resetsAt, status: 'allowed', durationMs: null, scoped: false, resetCadence: 'fixed' }],
  }],
});

describe('history.add', () => {
  it('keeps the last window after 24 days away, even when the first poll back lacks its usage', () => {
    history.clear();
    try {
      history.add(snapshot('2026-10-01T16:55:00Z', 100, '2026-10-01T17:00:00Z'));
      history.add(snapshot('2026-10-25T17:00:00Z', null, null));
      history.add(snapshot('2026-10-25T17:05:00Z', 2, '2026-11-01T17:00:00Z'));
      expect(history.summaries().map((s) => [s.resetAt, s.peak, s.exhaustedAt])).toEqual([
        [Date.parse('2026-10-01T17:00:00Z'), 100, Date.parse('2026-10-01T16:55:00Z')],
        [Date.parse('2026-11-01T17:00:00Z'), 2, null],
      ]);
      expect(history.all().map((s) => s.at)).toEqual(['2026-10-25T17:00:00Z', '2026-10-25T17:05:00Z']);
      // The poll without usage read nothing, so the time away stays unobserved.
      expect(history.observed().map((s) => [s.from, s.to])).toEqual([
        [Date.parse('2026-10-01T16:55:00Z'), Date.parse('2026-10-01T16:55:00Z')],
        [Date.parse('2026-10-25T17:05:00Z'), Date.parse('2026-10-25T17:05:00Z')],
      ]);
    } finally {
      history.clear();
    }
  });
});

describe('history.summaries', () => {
  it('backfills from stored samples when no summaries file exists yet', async () => {
    const stored = [sample('2026-10-25T16:50:00Z', 60, '2026-10-25T17:00:00Z'), sample('2026-10-25T17:05:00Z', 3, '2026-11-01T17:00:00Z')];
    vi.resetModules();
    vi.doMock('node:fs', () => ({ existsSync: (p: string) => p === 'unused', readFileSync: () => JSON.stringify(stored) }));
    try {
      const { history: fresh } = await import('./historyStore');
      expect(fresh.summaries().map((s) => [s.resetAt, s.peak])).toEqual([
        [Date.parse('2026-10-25T17:00:00Z'), 60],
        [Date.parse('2026-11-01T17:00:00Z'), 3],
      ]);
      // Stored samples 15 min apart are over the 10 min gap: two spans.
      expect(fresh.observed().map((s) => s.from)).toEqual([Date.parse('2026-10-25T16:50:00Z'), Date.parse('2026-10-25T17:05:00Z')]);
    } finally {
      vi.doUnmock('node:fs');
    }
  });
});

describe('appendSample', () => {
  it('replaces the newest point while it is within the spacing of the one before', () => {
    const two = [sample('2026-10-25T00:00:00Z', 10), sample('2026-10-25T00:01:00Z', 11)];
    expect(times(appendSample(two, sample('2026-10-25T00:02:00Z', 12)))).toEqual(['00:00', '00:02']);
  });

  it('appends once the newest point is a spacing past the one before', () => {
    const two = [sample('2026-10-25T00:00:00Z', 10), sample('2026-10-25T00:05:00Z', 11)];
    expect(times(appendSample(two, sample('2026-10-25T00:06:00Z', 12)))).toEqual(['00:00', '00:05', '00:06']);
  });

  it('keeps the last point before a reset', () => {
    const two = [sample('2026-10-25T00:00:00Z', 80, '2026-10-25T00:02:00Z'), sample('2026-10-25T00:01:00Z', 90, '2026-10-25T00:02:00Z')];
    expect(times(appendSample(two, sample('2026-10-25T00:03:00Z', 1)))).toEqual(['00:00', '00:01', '00:03']);
  });

  it('trims past retention', () => {
    const old = sample('2026-10-01T00:00:00Z', 5);
    const recent = sample('2026-10-24T00:00:00Z', 6);
    const out = appendSample([old, recent], sample('2026-10-25T00:00:00Z', 7));
    expect(out.map((s) => s.at)).toEqual(['2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z']);
  });
});
