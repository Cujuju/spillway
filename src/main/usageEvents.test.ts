import { describe, expect, it } from 'vitest';
import type { Credential, LimitWindow, UsageSnapshot } from '@shared/types';
import { diffUsage } from './usageEvents';

const cred = (id: string, patch: Partial<Credential> = {}): Credential => ({
  id, name: `${id}.json`, authIndex: id, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null,
  disabled: false, status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null,
  nextPick: false, preferred: false, weight: 1, plan: null, resetCredits: null, windows: [], ...patch,
});
const snap = (...credentials: Credential[]): UsageSnapshot => ({ fetchedAt: '2026-10-25T00:00:00Z', strategy: 'soonest-reset', credentials });
const fiveHour = (status: LimitWindow['status'], patch: Partial<LimitWindow> = {}): LimitWindow[] => [{
  key: 'five_hour', label: '5-hour', usedPercent: status === 'rejected' ? 100 : 0,
  resetsAt: '2026-10-25T03:00:00Z', status, durationMs: 5 * 3_600_000, scoped: false, resetCadence: 'on_use', ...patch,
}];

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

  it.each([null, 'allowed', 'allowed_warning'] as const)('does not report recovery while fully used when status changes to %s', (status) => {
    const rejected = snap(cred('a', { windows: fiveHour('rejected') }));
    const lookup = snap(cred('a', { windows: fiveHour(status, { usedPercent: 100 }) }));
    expect(diffUsage(rejected, lookup)).toEqual([]);
    expect(diffUsage(lookup, rejected)).toEqual([]);
  });

  it('reports percentage-only limits and recovery without a status', () => {
    const allowed = snap(cred('a', { windows: fiveHour(null, { usedPercent: 25 }) }));
    const exhausted = snap(cred('a', { windows: fiveHour(null, { usedPercent: 100 }) }));
    expect(diffUsage(allowed, exhausted)).toMatchObject([{ kind: 'limitHit', windowLabel: '5-hour', resetsAt: '2026-10-25T03:00:00Z' }]);
    expect(diffUsage(exhausted, allowed)).toMatchObject([{ kind: 'limitReset', windowLabel: '5-hour' }]);
  });

  it.each([
    { label: 'missing window', windows: [] },
    { label: 'unknown status and usage', windows: fiveHour(null, { usedPercent: null }) },
  ])('does not treat $label as a reset', ({ windows }) => {
    const rejected = snap(cred('a', { windows: fiveHour('rejected') }));
    expect(diffUsage(rejected, snap(cred('a', { windows })))).toEqual([]);
  });

  it('keeps an explicit rejection exhausted even below 100%', () => {
    const rejected = snap(cred('a', { windows: fiveHour('rejected') }));
    const stillRejected = snap(cred('a', { windows: fiveHour('rejected', { usedPercent: 95 }) }));
    expect(diffUsage(rejected, stillRejected)).toEqual([]);
  });

  it('reports a change of the next-pick account', () => {
    const before = snap(cred('a', { nextPick: true }), cred('b'));
    const after = snap(cred('a'), cred('b', { nextPick: true }));
    const events = diffUsage(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'accountSwitched', provider: 'claude' });
  });
});
