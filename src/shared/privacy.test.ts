import { describe, expect, it } from 'vitest';
import { maskCredential, maskEmail, maskEmails } from './privacy';
import type { Credential } from './types';

describe('maskEmail', () => {
  it('hides the whole username and keeps the domain', () => {
    expect(maskEmail('someone@example.com')).toBe('•••@example.com');
  });
});

it('masks grant text while preserving the exact redemption identity', () => {
  const credential: Credential = { id: 'account', authIndex: 'account-index', provider: 'claude', name: 'account', label: 'Work',
    note: null, email: null, statusMessage: null, lastUsedAt: null, disabled: false, canRefresh: true, status: 'active', priority: 0,
    cooldownUntil: null, observedAt: null, nextPick: false, preferred: false, weight: 1, plan: null, windows: [],
    resetCredits: { available: 1, applicable: 1, checkedAt: 'now', expiries: [], grants: [{
      id: 'grant-identity', label: 'For person@example.com', scope: 'fable', available: 1, applicable: 1,
      expiresAt: null, clears: [], givesBackWeekly: true, unavailableReason: 'Contact person@example.com',
    }] } };
  expect(maskCredential(credential).resetCredits?.grants?.[0]).toMatchObject({
    id: 'grant-identity', label: 'For •••@example.com', unavailableReason: 'Contact •••@example.com',
  });
  expect(credential.resetCredits?.grants?.[0]?.label).toBe('For person@example.com');
});

describe('maskEmails', () => {
  it('masks an email inside an auth file name', () => {
    expect(maskEmails('claude-someone@example.com.json')).toBe('•••@example.com.json');
  });
  it('masks every email and leaves other text', () => {
    expect(maskEmails('from a.b@x.io to c@y.org')).toBe('from •••@x.io to •••@y.org');
  });
  it('leaves text without an email', () => {
    expect(maskEmails('Work account')).toBe('Work account');
  });
});
