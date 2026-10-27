import { describe, expect, it } from 'vitest';
import type { CredentialModel } from '@shared/types';
import { groupModelFamilies } from './modelFamilies';

const model = (id: string): CredentialModel => ({ id, displayName: null, ownedBy: null });
const ids = [
  'claude-haiku-4-5-20251001',
  'claude-opus-4-6',
  'claude-opus-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-opus-4-1-20250805',
  'claude-opus-4-20250514',
  'claude-3-7-sonnet-20250219',
  'gpt-5.1-codex',
  'gpt-5',
];

describe('groupModelFamilies', () => {
  const families = groupModelFamilies(ids.map(model));

  it('orders tiered families first, then the rest alphabetically', () => {
    expect(families.map((f) => f.key)).toEqual(['claude-fable', 'claude-opus', 'claude-sonnet', 'claude-haiku', 'gpt', 'gpt-codex']);
  });

  it('puts the newest version first and the rest newest first', () => {
    const opus = families.find((f) => f.key === 'claude-opus')!;
    expect(opus.latest.model.id).toBe('claude-opus-5-5');
    expect(opus.older.map((v) => v.label)).toEqual(['5', '4.6', '4.1', '4']);
  });

  it('reads the version wherever it sits in the ID, ignoring the snapshot date', () => {
    const sonnet = families.find((f) => f.key === 'claude-sonnet')!;
    expect([sonnet.latest.label, ...sonnet.older.map((v) => v.label)]).toEqual(['5.5', '3.7']);
    expect(families.find((f) => f.key === 'gpt-codex')!.latest.label).toBe('5.1');
  });

  it('breaks a version tie with the later snapshot date', () => {
    const f = groupModelFamilies([model('claude-opus-4-5-20250101'), model('claude-opus-4-5-20251101')])[0];
    expect(f?.latest.model.id).toBe('claude-opus-4-5-20251101');
  });

  it('labels a model without a version by its ID', () => {
    expect(groupModelFamilies([model('kimi-k2-thinking')])[0]?.latest.label).toBe('kimi-k2-thinking');
  });
});
