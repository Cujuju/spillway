import { describe, expect, it } from 'vitest';
import { emailDomain, parseUsageSnapshot } from './usageParse';

const labelOf = (fields: Record<string, unknown>) =>
  parseUsageSnapshot({ credentials: [{ id: 'a', provider: 'claude', ...fields }] }).credentials[0]!.label;

describe('emailDomain', () => {
  it('returns the part after the @', () => expect(emailDomain('someone@pm.me')).toBe('pm.me'));
  it('is null without an email or domain', () => {
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain('someone@')).toBeNull();
  });
});

describe('credential label', () => {
  it('defaults to the email domain', () => expect(labelOf({ email: 'someone@pm.me', label: 'someone@pm.me' })).toBe('pm.me'));
  it('prefers the note', () => expect(labelOf({ email: 'someone@pm.me', note: 'Work' })).toBe('Work'));
  it('falls back to the proxy label without an email', () => expect(labelOf({ label: 'API key' })).toBe('API key'));
});
