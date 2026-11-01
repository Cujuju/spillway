import { describe, expect, it } from 'vitest';
import { maskEmail, maskEmails } from './privacy';

describe('maskEmail', () => {
  it('hides the whole username and keeps the domain', () => {
    expect(maskEmail('someone@example.com')).toBe('•••@example.com');
  });
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
