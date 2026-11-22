import { describe, expect, it, vi } from 'vitest';
import { createMemo, createRoot, createSignal } from 'solid-js';
import type { Credential, ResetCreditGrant, ResetCredits } from '@shared/types';
import { createHoldBinding, groupGrants, restoresText, type GrantGroup, hasResetCredits, outcomeText, resetMode, unusableNote } from './resetGrants';

const AT = Date.parse('2026-11-15T12:00:00Z');
const SOON = '2026-11-20T00:00:00Z';
const LATER = '2026-12-01T00:00:00Z';
const PAST = '2026-11-01T00:00:00Z';

// Both scopes report upstream type "full"; only `scope` tells them apart.
const grant = (id: string, scope: ResetCreditGrant['scope'], patch: Partial<ResetCreditGrant> = {}): ResetCreditGrant => ({
  id, label: `Grant ${id}`, scope, available: 1, applicable: 1, expiresAt: LATER,
  clears: scope === 'fable' ? ['five_hour', 'seven_day_overage_included'] : ['five_hour', 'seven_day', 'seven_day_overage_included'],
  givesBackWeekly: scope === 'fable', unavailableReason: null, ...patch,
});

const cred = (provider: string, resetCredits: ResetCredits | null): Credential => ({
  id: 'c', name: 'c', authIndex: 'c', provider, label: 'Acct', note: null, email: null, lastUsedAt: null, disabled: false, canRefresh: true,
  status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false, preferred: false,
  weight: 1, plan: null, resetCredits, windows: [],
});
/** The first group, failing the test when there is none. */
const first = (groups: GrantGroup[]): GrantGroup => {
  expect(groups.length).toBeGreaterThan(0);
  return groups[0]!;
};
const credits = (grants?: ResetCreditGrant[]): ResetCredits => ({ available: 2, applicable: 2, checkedAt: 'x', expiries: [], grants });

describe('groupGrants', () => {
  it('keeps mixed Fable and general grants apart, each with its own total and target', () => {
    const groups = groupGrants([grant('g1', 'general'), grant('f1', 'fable', { available: 2 }), grant('f2', 'fable', { expiresAt: SOON })], AT);
    expect(groups.map((g) => [g.scope, g.available, g.target?.id])).toEqual([['fable', 3, 'f2'], ['general', 1, 'g1']]);
  });

  it('targets the earliest known expiry, then never-expiring, then by ID', () => {
    const fable = first(groupGrants([grant('b', 'fable', { expiresAt: null }), grant('a', 'fable', { expiresAt: null }), grant('c', 'fable', { expiresAt: LATER })], AT));
    expect(fable.target?.id).toBe('c');
    expect(first(groupGrants([grant('b', 'fable', { expiresAt: null }), grant('a', 'fable', { expiresAt: null })], AT)).target?.id).toBe('a');
  });

  it('skips unusable grants and never falls back to another scope', () => {
    const groups = groupGrants([
      grant('f-paused', 'fable', { unavailableReason: 'Paused by provider.' }),
      grant('f-expired', 'fable', { expiresAt: PAST }),
      grant('f-idle', 'fable', { applicable: 0 }),
      grant('g1', 'general'),
    ], AT);
    expect(groups[0]).toMatchObject({ scope: 'fable', available: 3, applicable: 0, target: null });
    expect(unusableNote(first(groups), AT)).toBe('Paused by provider.');
    expect(groups[1]?.target?.id).toBe('g1');
  });

  it('shows unknown scope as its own group that is never redeemable', () => {
    const unknown = first(groupGrants([grant('u1', 'unknown')], AT));
    expect(unknown).toMatchObject({ scope: 'unknown', available: 1, target: null });
    expect(unusableNote(unknown, AT)).toMatch(/Unrecognized/);
  });

  it('drops grants with nothing held and lists only future expiries', () => {
    const fable = first(groupGrants([grant('f0', 'fable', { available: 0 }), grant('f1', 'fable', { expiresAt: LATER }), grant('f2', 'fable', { expiresAt: SOON })], AT));
    expect(fable.grants.map((g) => g.id)).toEqual(['f2', 'f1']);
    expect(fable.expiries).toEqual([SOON, LATER]);
  });
});

describe('expiry and restore text', () => {
  it('orders expiries by time, not by text', () => {
    // Text order puts the Z time first; it is three hours later than the offset one.
    const offset = '2026-11-20T00:00:00+05:00';
    const utc = '2026-11-19T22:00:00Z';
    const fable = first(groupGrants([grant('a', 'fable', { expiresAt: utc }), grant('b', 'fable', { expiresAt: offset })], AT));
    expect(fable.expiries).toEqual([offset, utc]);
    expect(fable.target?.id).toBe('b');
  });

  it('describes what each known scope restores in plain words', () => {
    expect(restoresText(grant('g', 'general').clears, [])).toBe('5-hour usage, weekly usage, Fable weekly usage');
    expect(restoresText(grant('f', 'fable').clears, [])).toBe('5-hour usage, Fable weekly usage');
    const windows = [{ key: 'monthly', label: 'Monthly', usedPercent: null, resetsAt: null, status: null, durationMs: null, scoped: false, resetCadence: null }];
    expect(restoresText(['monthly', 'mystery'], windows)).toBe('Monthly, mystery');
  });
});

describe('resetMode', () => {
  it('spends Claude only through typed grants; legacy Claude data is untyped', () => {
    expect(resetMode(cred('claude', credits([grant('f1', 'fable')])))).toBe('grants');
    expect(resetMode(cred('claude', credits()))).toBe('untyped');
    expect(resetMode(cred('claude', credits([])))).toBe('untyped');
    expect(resetMode(cred('codex', credits()))).toBe('credits');
  });

  it('shows accounts holding any credit or grant', () => {
    expect(hasResetCredits(cred('claude', { ...credits([grant('f1', 'fable')]), available: 0 }))).toBe(true);
    expect(hasResetCredits(cred('codex', { ...credits(), available: 0 }))).toBe(false);
    expect(hasResetCredits(cred('codex', null))).toBe(false);
  });
});

describe('outcomeText', () => {
  it('names the spent scope for Claude and keeps Codex wording', () => {
    expect(outcomeText('reset', 'Acct', 'fable')).toBe('Fable reset applied to Acct; its limits were re-read.');
    expect(outcomeText('reset', 'Acct', 'general')).toBe('General reset applied to Acct; its limits were re-read.');
    expect(outcomeText('reset', 'Acct')).toBe('Reset applied to Acct; its limits were re-read.');
    expect(outcomeText('no_credit', 'Acct')).toBe('Acct holds no usable reset credit.');
  });
});

describe('createHoldBinding', () => {
  /** A badge's target, derived like the component: the group's chosen grant, reactive to data and clock. */
  const setup = () => createRoot((dispose) => {
    const [grants, setGrants] = createSignal([grant('f1', 'fable'), grant('g1', 'general')]);
    const [at, setAt] = createSignal(AT);
    const groups = createMemo(() => groupGrants(grants(), at()));
    const general = () => groups().find((g) => g.scope === 'general')?.target?.id ?? null;
    const cancel = vi.fn();
    return { binding: createHoldBinding(general, cancel), cancel, setGrants, setAt, dispose };
  });

  it('spends exactly the selected scope grant, not the default first grant', () => {
    const { binding, cancel, dispose } = setup();
    binding.bind();
    expect(binding.take()).toBe('g1');
    expect(cancel).not.toHaveBeenCalled();
    dispose();
  });

  it('cancels the hold and spends nothing when the bound grant changes', () => {
    const { binding, cancel, setGrants, dispose } = setup();
    binding.bind();
    setGrants([grant('f1', 'fable'), grant('g1', 'general', { expiresAt: LATER }), grant('g0', 'general', { expiresAt: SOON })]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(binding.take()).toBeNull();
    dispose();
  });

  it('cancels when the bound grant expires mid-hold', () => {
    const { binding, cancel, setAt, dispose } = setup();
    binding.bind();
    setAt(Date.parse(LATER) + 1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(binding.take()).toBeNull();
    dispose();
  });

  it('ignores updates that keep the same target and when no hold is bound', () => {
    const { binding, cancel, setGrants, setAt, dispose } = setup();
    setGrants([grant('g1', 'general'), grant('f9', 'fable')]);
    binding.bind();
    setAt(AT + 1);
    setGrants([grant('g1', 'general', { label: 'Renamed' })]);
    expect(cancel).not.toHaveBeenCalled();
    expect(binding.take()).toBe('g1');
    binding.release();
    setGrants([]);
    expect(cancel).not.toHaveBeenCalled();
    dispose();
  });
});
