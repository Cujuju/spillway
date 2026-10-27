import { describe, expect, it } from 'vitest';
import type { Credential, LimitWindow } from '@shared/types';
import { durationChoices, keyForDuration, nextResetAt, poolSegments, scopedChoices, valueAt } from './poolWindows';

const H = 3_600_000;
const win = (key: string, label: string, durationMs: number | null, scoped = false): LimitWindow =>
  ({ key, label, durationMs, scoped, usedPercent: 10, resetsAt: null, status: null, resetCadence: null }) as LimitWindow;
const cred = (windows: LimitWindow[]) => ({ windows }) as Credential;

const claude = [cred([win('five_hour', '5-hour', 5 * H), win('seven_day', 'Weekly', 168 * H), win('seven_day_fable', 'Weekly · Fable', 168 * H, true)])];
const codex = [cred([win('primary', '5-hour', 5 * H), win('secondary', 'Weekly', 168 * H)])];

describe('window choices', () => {
  it('groups several providers by account-wide length', () => {
    expect(durationChoices([claude, codex])).toEqual([{ value: String(5 * H), label: '5-hour' }, { value: String(168 * H), label: 'Weekly' }]);
  });
  it('lists a provider\'s scoped windows, shortest first, unknown length last', () => {
    const spend = cred([win('spend', 'Spend limit', null, true), win('five_hour', '5-hour', 5 * H)]);
    expect(scopedChoices([...claude, spend])).toEqual([{ value: 'seven_day_fable', label: 'Weekly · Fable' }, { value: 'spend', label: 'Spend limit' }]);
    expect(scopedChoices(codex)).toEqual([]);
  });
  it('finds each provider its own key for a length, skipping scoped windows', () => {
    expect(keyForDuration(claude, 168 * H)).toBe('seven_day');
    expect(keyForDuration(codex, 168 * H)).toBe('secondary');
    expect(keyForDuration(codex, 24 * H)).toBeNull();
  });
});

describe('card lines', () => {
  const NOW = Date.parse('2026-01-01T00:00:00Z');
  const at = (h: number) => new Date(NOW + h * H).toISOString();
  const acct = (id: string, used: number | null, resetsAt: string | null, status: LimitWindow['status'] = null) =>
    ({ id, windows: [{ ...win('seven_day', 'Weekly', 168 * H), usedPercent: used, resetsAt, status }] }) as Credential;
  const accounts = [acct('max', 84, at(5)), acct('pro', 27, at(2), 'rejected'), acct('new', null, null), acct('unshared', 10, at(1))];
  const shares = new Map([['max', { share: 5 / 6, cost: {} }], ['pro', { share: 1 / 6, cost: {} }], ['new', { share: 0, cost: {} }]]);

  it('gives each shared account with data one segment, sized by its share', () => {
    expect(poolSegments(accounts, 'seven_day', shares)).toEqual([
      { id: 'max', share: 5 / 6, usedPercent: 84, rejected: false },
      { id: 'pro', share: 1 / 6, usedPercent: 27, rejected: true },
    ]);
  });
  it('finds the soonest pending reset and ignores past ones', () => {
    expect(nextResetAt(accounts, 'seven_day', NOW)).toBe(NOW + H);
    expect(nextResetAt(accounts, 'seven_day', NOW + 6 * H)).toBeNull();
  });
});

describe('valueAt', () => {
  const pts = [{ t: 0, remaining: 100 }, { t: 10, remaining: 50 }, { t: 20, remaining: 50 }];
  it('interpolates between points and is exact on them', () => {
    expect(valueAt(pts, 5)).toBe(75);
    expect(valueAt(pts, 10)).toBe(50);
    expect(valueAt(pts, 0)).toBe(100);
  });
  it('is null outside the series', () => {
    expect(valueAt(pts, -1)).toBeNull();
    expect(valueAt(pts, 21)).toBeNull();
    expect(valueAt([], 0)).toBeNull();
  });
});
