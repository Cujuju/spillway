import { describe, expect, it } from 'vitest';
import type { Credential, UsageSnapshot } from './types';
import { readTray, shownPercent, thresholdInUnit, trayIconText, trayLevel } from './trayValues';

const cred = (id: string, used: number, patch: Partial<Credential> = {}): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, accountView: false, preferred: false, weight: 1, plan: null, resetCredits: null,
  windows: [{ key: 'five_hour', label: '5-hour', usedPercent: used, resetsAt: `2026-10-25T0${used % 9}:00:00Z`, status: 'allowed', durationMs: null, scoped: false, resetCadence: null }],
  ...patch,
});
const snap = (...credentials: Credential[]): UsageSnapshot => ({ fetchedAt: '', strategy: 'soonest-reset', credentials });
/** Stand-in pool reader: the renderer passes poolRemaining (Dashboard math, tested in forecast.test). */
const evenPool = (cs: Credential[], key: string) => cs.reduce((sum, c) => sum + 100 - c.windows.find((w) => w.key === key)!.usedPercent!, 0) / cs.length;
const spec = (scope: 'active' | 'pool' | 'lowest' | 'account', credentialId?: string) =>
  ({ id: 'x', provider: 'claude', windowKey: 'five_hour', scope, credentialId });

describe('readTray', () => {
  const s = snap(cred('a', 20), cred('b', 80, { nextPick: true }), cred('c', 50, { disabled: true }));

  it('active follows the next-pick account', () => {
    expect(readTray(spec('active'), s, evenPool)).toMatchObject({ usedPercent: 80, source: 'b' });
  });
  it('pool reads the pool helper over enabled accounts only', () => {
    expect(readTray(spec('pool'), s, evenPool).usedPercent).toBe(50);
  });
  it('lowest shows the most used account', () => {
    expect(readTray(spec('lowest'), s, evenPool).usedPercent).toBe(80);
  });
  it('account reads one account', () => {
    expect(readTray(spec('account', 'a'), s, evenPool).usedPercent).toBe(20);
  });
  it('reports no data without a snapshot', () => {
    expect(readTray(spec('pool'), null, evenPool).usedPercent).toBeNull();
  });
});

describe('trayLevel', () => {
  it('maps thresholds', () => {
    expect(trayLevel(null, 75, 90)).toBe('none');
    expect(trayLevel(10, 75, 90)).toBe('ok');
    expect(trayLevel(75, 75, 90)).toBe('warn');
    expect(trayLevel(95, 75, 90)).toBe('critical');
  });
});

describe('thresholdInUnit', () => {
  it('shows a stored percent-used threshold in the icon unit and converts it back', () => {
    expect(thresholdInUnit(75, 'used')).toBe(75);
    expect(thresholdInUnit(75, 'remaining')).toBe(25);
    expect(thresholdInUnit(thresholdInUnit(90, 'remaining'), 'remaining')).toBe(90);
  });

  it('agrees with the icon digits at the threshold', () => {
    const warnUsed = 75;
    expect(trayLevel(warnUsed, warnUsed, 90)).toBe('warn');
    expect(shownPercent(warnUsed, 'remaining')).toBe(thresholdInUnit(warnUsed, 'remaining'));
  });
});

describe('shownPercent and trayIconText', () => {
  it('shows remaining or used, never below zero, and a dash without data', () => {
    expect(shownPercent(30, 'remaining')).toBe(70);
    expect(shownPercent(30, 'used')).toBe(30);
    expect(shownPercent(104, 'remaining')).toBe(0);
    expect(trayIconText(shownPercent(null, 'remaining'))).toBe('–');
    expect(trayIconText(69.6)).toBe('70');
  });
});
