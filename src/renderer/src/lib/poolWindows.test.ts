import { describe, expect, it } from 'vitest';
import type { Credential, LimitWindow } from '@shared/types';
import { durationChoices, keyChoices, keyForDuration, valueAt } from './poolWindows';

const H = 3_600_000;
const win = (key: string, label: string, durationMs: number | null, scoped = false): LimitWindow =>
  ({ key, label, durationMs, scoped, usedPercent: 10, resetsAt: null, status: null, resetCadence: null }) as LimitWindow;
const cred = (windows: LimitWindow[]) => ({ windows }) as Credential;

const claude = [cred([win('five_hour', '5-hour', 5 * H), win('seven_day', 'Weekly', 168 * H), win('seven_day_fable', 'Weekly · Fable', 168 * H, true)])];
const codex = [cred([win('primary', '5-hour', 5 * H), win('secondary', 'Weekly', 168 * H)])];

describe('window choices', () => {
  it('lists one provider by key, shortest first', () => {
    expect(keyChoices(claude).map((c) => c.value)).toEqual(['five_hour', 'seven_day', 'seven_day_fable']);
  });
  it('groups several providers by account-wide length', () => {
    expect(durationChoices([claude, codex])).toEqual([{ value: String(5 * H), label: '5-hour' }, { value: String(168 * H), label: 'Weekly' }]);
  });
  it('finds each provider its own key for a length, skipping scoped windows', () => {
    expect(keyForDuration(claude, 168 * H)).toBe('seven_day');
    expect(keyForDuration(codex, 168 * H)).toBe('secondary');
    expect(keyForDuration(codex, 24 * H)).toBeNull();
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
