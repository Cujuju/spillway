import { describe, expect, it } from 'vitest';
import { emailDomain, parseUsageSnapshot } from './usageParse';

const parseOne = (fields: Record<string, unknown>) =>
  parseUsageSnapshot({ strategy: 'soonest-reset', credentials: [{ id: 'a', provider: 'claude', ...fields }] }).credentials[0]!;
const labelOf = (fields: Record<string, unknown>) => parseOne(fields).label;

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
  it('numbers labels shared within a provider, in id order', () => {
    const labels = parseUsageSnapshot({
      credentials: [
        { id: 'b', provider: 'claude', email: 'two@gmail.com' },
        { id: 'a', provider: 'claude', email: 'one@gmail.com' },
        { id: 'c', provider: 'codex', email: 'three@gmail.com' },
        { id: 'd', provider: 'claude', email: 'four@pm.me' },
      ],
    }).credentials.map((c) => c.label);
    expect(labels).toEqual(['gmail.com 2', 'gmail.com 1','gmail.com', 'pm.me']);
  });
});

describe('windows and weight', () => {
  it('reads window length, scope, reset cadence and weight', () => {
    const c = parseOne({
      weight: 3,
      windows: [{ key: 'five_hour', used_percent: 12, duration_seconds: 18000, scoped: false, reset_cadence: 'on_use' }],
    });
    expect(c.weight).toBe(3);
    expect(c.windows[0]).toMatchObject({ durationMs: 18_000_000, scoped: false, resetCadence: 'on_use' });
  });
  it('falls back for older proxies: key-based length, unknown cadence, default weight', () => {
    const c = parseOne({ windows: [{ key: 'seven_day', used_percent: 40 }] });
    expect(c.weight).toBe(1);
    expect(c.windows[0]).toMatchObject({ durationMs: 604_800_000, resetCadence: null });
  });
  it('drops an unknown cadence', () => {
    expect(parseOne({ windows: [{ key: 'k', reset_cadence: 'monthly' }] }).windows[0]!.resetCadence).toBeNull();
  });
});
