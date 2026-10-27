import { describe, expect, it } from 'vitest';
import { emailDomain, errorText, parseUsageSnapshot } from './usageParse';

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

describe('errorText', () => {
  it('reads the message from provider error bodies', () => {
    const anthropic = '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."},"request_id":"req_1"}';
    expect(parseOne({ status_message: anthropic }).statusMessage).toBe('Rate limited.');
    expect(errorText('{"error":"bad key"}')).toBe('bad key');
    expect(errorText('{"message":"nope"}')).toBe('nope');
  });
  it('keeps plain text, invalid JSON and bodies without a message', () => {
    expect(errorText('unauthorized')).toBe('unauthorized');
    expect(errorText('{"error":')).toBe('{"error":');
    expect(errorText('{"code":1}')).toBe('{"code":1}');
    expect(errorText('')).toBeNull();
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
  it('reads masked API-key identity and request counts without subscription limits', () => {
    const c = parseOne({ label: 'claude-apikey', api_key: { masked: 'sk-a…1234', success: 7, failed: 2 } });
    expect(c.apiKey).toEqual({ masked: 'sk-a…1234', success: 7, failed: 2 });
    expect(c.label).toBe('sk-a…1234');
    expect(c.windows).toEqual([]);
    expect(c.plan).toBeNull();
    expect(parseOne({}).apiKey).toBeNull();
    expect(parseOne({ api_key: { masked: '••••', success: -1, failed: 'invalid' } }).apiKey)
      .toEqual({ masked: '••••', success: 0, failed: 0 });
  });
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
  it('reads the plan, dropping a missing or non-positive multiplier', () => {
    expect(parseOne({ plan: { tier: 'default_claude_max_5x', label: 'Max 5x', multiplier: 5 } }).plan)
      .toEqual({ tier: 'default_claude_max_5x', label: 'Max 5x', multiplier: 5 });
    expect(parseOne({ plan: { tier: 'enterprise', multiplier: null } }).plan).toEqual({ tier: 'enterprise', label: 'enterprise', multiplier: null });
    expect(parseOne({}).plan).toBeNull();
  });
  it('reads reset credits, capping usable ones at the held count', () => {
    expect(parseOne({ reset_credits: { available: 1, applicable: 0, checked_at: '2026-10-26T12:00:00Z' } }).resetCredits)
      .toEqual({ available: 1, applicable: 0, checkedAt: '2026-10-26T12:00:00Z' });
    expect(parseOne({ reset_credits: { available: 1, applicable: 3, checked_at: 'x' } }).resetCredits?.applicable).toBe(1);
    expect(parseOne({ reset_credits: null }).resetCredits).toBeNull();
    expect(parseOne({}).resetCredits).toBeNull();
  });
  it('drops an unknown cadence', () => {
    expect(parseOne({ windows: [{ key: 'k', reset_cadence: 'monthly' }] }).windows[0]!.resetCadence).toBeNull();
  });
});
