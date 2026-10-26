import { describe, expect, it } from 'vitest';
import type { Credential, UsageSnapshot } from '@shared/types';
import { diffUsage } from './usageEvents';

const cred = (id: string, patch: Partial<Credential> = {}): Credential => ({
  id, name: `${id}.json`, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null,
  disabled: false, status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null,
  nextPick: false, accountView: false, preferred: false, weight: 1, plan: null, resetCredits: null, windows: [], ...patch,
});
const snap = (...credentials: Credential[]): UsageSnapshot => ({ fetchedAt: '2026-10-25T00:00:00Z', strategy: 'soonest-reset', credentials });
const fiveHour = (status: 'allowed' | 'rejected') => [{ key: 'five_hour', label: '5-hour', usedPercent: 100, resetsAt: null, status, durationMs: 5 * 3_600_000, scoped: false, resetCadence: null }];

describe('diffUsage', () => {
  it('reports nothing for the first snapshot', () => {
    expect(diffUsage(null, snap(cred('a')))).toEqual([]);
  });

  it('reports a limit hit and its later reset', () => {
    const allowed = snap(cred('a', { windows: fiveHour('allowed') }));
    const rejected = snap(cred('a', { windows: fiveHour('rejected') }));
    expect(diffUsage(allowed, rejected).map((e) => e.kind)).toEqual(['limitHit']);
    expect(diffUsage(rejected, allowed).map((e) => e.kind)).toEqual(['limitReset']);
  });

  it('reports a change of the next-pick account', () => {
    const before = snap(cred('a', { nextPick: true }), cred('b'));
    const after = snap(cred('a'), cred('b', { nextPick: true }));
    const events = diffUsage(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'accountSwitched', provider: 'claude' });
  });
});
