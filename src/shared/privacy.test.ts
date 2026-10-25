import { describe, expect, it } from 'vitest';
import { maskEmail, maskEmails } from './privacy';

describe('maskEmail', () => {
  it('keeps the domain', () => {
    expect(maskEmail('someone@example.com')).toBe('so…@example.com');
  });
});

describe('maskEmails', () => {
  it('masks an email inside an auth file name', () => {
    expect(maskEmails('claude-someone@example.com.json')).toBe('cl…@example.com.json');
  });
  it('masks every email and leaves other text', () => {
    expect(maskEmails('from a.b@x.io to c@y.org')).toBe('from a.…@x.io to c…@y.org');
  });
  it('leaves text without an email', () => {
    expect(maskEmails('Work account')).toBe('Work account');
  });
});
