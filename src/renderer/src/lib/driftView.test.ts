import { describe, expect, it } from 'vitest';
import type { DriftDay, DriftSeries } from '@shared/drift';
import { recentChanges, RECENT_DAYS, signedPercent, sumDays, summarizeMetric, verdict, summarizeSeries } from './driftView';

const DAYS = 30;
const dayOf = (i: number) => `2026-10-${String(i + 1).padStart(2, '0')}`;
const day = (i: number, thinkingPerReply: number, replies = 100): DriftDay => ({
  day: dayOf(i), replies, failed: 0, outputTokens: replies * (thinkingPerReply + 400), thinkingTokens: replies * thinkingPerReply,
  thinkingKnown: replies, noThinking: Math.round(replies * 0.3), ttftSumMs: replies * 1500, ttftCount: replies, latencySumMs: replies * 9000, latencyCount: replies,
});
// Gentle wobble so the baseline has a spread, as real days do.
const wobble = (i: number) => (i % 3) * 6;
const series = (perDay: (i: number) => number, changes: DriftSeries['changes'] = []): DriftSeries => ({
  key: 'claude|claude-opus-5-5|high', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', replies: DAYS * 100,
  days: Array.from({ length: DAYS }, (_, i) => day(i, perDay(i))), changes,
});

describe('sumDays', () => {
  it('pools counts so a window is a ratio of sums', () => {
    const total = sumDays([day(0, 200, 10), day(1, 400, 30)]);
    expect(total.replies).toBe(40);
    expect(total.thinkingTokens / total.thinkingKnown).toBe(350);
  });
});

describe('summarizeMetric', () => {
  it('compares the last week with the two weeks before', () => {
    const s = summarizeMetric(series((i) => (i >= DAYS - RECENT_DAYS ? 300 : 250) + wobble(i)), 'thinkingPerReply');
    expect(s.recent).toBeGreaterThan(s.before!);
    expect(s.change).toBeGreaterThan(0.15);
    expect(s.judged).toBe(true);
  });

  it('flags a sustained drop and reports its direction', () => {
    const s = summarizeMetric(series((i) => (i >= DAYS - 4 ? 120 : 250 + wobble(i))), 'thinkingPerReply');
    expect(s.flaggedDays).toBeGreaterThan(0);
    expect(s.direction).toBe('down');
  });
});

describe('verdict', () => {
  it('is steady when nothing is flagged', () => {
    const s = series((i) => 250 + wobble(i));
    expect(verdict(s, summarizeSeries(s)).tone).toBe('steady');
  });

  it('names a client change in the same week as a suspect', () => {
    const change = { at: `${dayOf(DAYS - 3)}T10:00:00.000Z`, day: dayOf(DAYS - 3), kind: 'client-version' as const, client: 'claude-cli', from: '2.1.316', to: '2.1.317', details: [] };
    const s = series((i) => (i >= DAYS - 3 ? 120 : 250 + wobble(i)), [change]);
    const v = verdict(s, summarizeSeries(s));
    expect(v.tone).toBe('unusual');
    expect(v.detail).toContain('2.1.316 → 2.1.317');
    expect(recentChanges(s)).toHaveLength(1);
  });

  it('asks for more history when no day has a baseline', () => {
    const s = { ...series(() => 250), days: [day(0, 250), day(1, 250)] };
    expect(verdict(s, summarizeSeries(s)).tone).toBe('unknown');
  });
});

describe('signedPercent', () => {
  it('signs and rounds', () => {
    expect(signedPercent(0.254)).toBe('+25%');
    expect(signedPercent(-0.042)).toBe('−4.2%');
    expect(signedPercent(0)).toBe('0.0%');
  });
});
