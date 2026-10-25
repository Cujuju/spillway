import { describe, expect, it } from 'vitest';
import type { Credential, UsageSnapshot } from './types';
import { readTray, trayLevel } from './trayValues';

const cred = (id: string, used: number, patch: Partial<Credential> = {}): Credential => ({
  id, name: id, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null, disabled: false,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false,
  windows: [{ key: 'five_hour', label: '5-hour', usedPercent: used, resetsAt: `2026-10-25T0${used % 9}:00:00Z`, status: 'allowed' }],
  ...patch,
});
const snap = (...credentials: Credential[]): UsageSnapshot => ({ fetchedAt: '', strategy: 'soonest-reset', credentials });
const spec = (scope: 'active' | 'pool' | 'lowest' | 'account', credentialId?: string) =>
  ({ id: 'x', provider: 'claude', windowKey: 'five_hour', scope, credentialId });

describe('readTray', () => {
  const s = snap(cred('a', 20), cred('b', 80, { nextPick: true }), cred('c', 50, { disabled: true }));

  it('active follows the next-pick account', () => {
    expect(readTray(spec('active'), s)).toMatchObject({ usedPercent: 80, source: 'b' });
  });
  it('pool averages enabled accounts only', () => {
    expect(readTray(spec('pool'), s).usedPercent).toBe(50);
  });
  it('lowest shows the most used account', () => {
    expect(readTray(spec('lowest'), s).usedPercent).toBe(80);
  });
  it('account reads one account', () => {
    expect(readTray(spec('account', 'a'), s).usedPercent).toBe(20);
  });
  it('reports no data without a snapshot', () => {
    expect(readTray(spec('pool'), null).usedPercent).toBeNull();
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
