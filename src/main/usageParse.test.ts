import { describe, expect, it } from 'vitest';
import { emailDomain, errorText, parseUsageSnapshot } from './usageParse';

const parseOne = (fields: Record<string, unknown>) =>
  parseUsageSnapshot({ strategy: 'soonest-reset', credentials: [{ id: 'a', provider: 'claude', ...fields }] }).credentials[0]!;
const labelOf = (fields: Record<string, unknown>) => parseOne(fields).label;

describe('emailDomain', () => {
  it('returns the part after the @', () => expect(emailDomain('someone@example.com')).toBe('example.com'));
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

describe('Claude overage window', () => {
  const overage = (fields: Record<string, unknown>) => ({ key: 'overage', label: 'Overage', scoped: true, ...fields });
  const keysOf = (provider: string, window: Record<string, unknown>) =>
    parseOne({ provider, windows: [{ key: 'five_hour', status: 'allowed', used_percent: 10 }, window] }).windows.map((w) => w.key);

  it('drops a status-only rejection: pay-as-you-go is off', () =>
    expect(keysOf('claude', overage({ status: 'rejected' }))).toEqual(['five_hour']));
  it('keeps it when it reports usage or a reset: pay-as-you-go is on', () => {
    expect(keysOf('claude', overage({ status: 'allowed' }))).toEqual(['five_hour', 'overage']);
    expect(keysOf('claude', overage({ status: 'rejected', used_percent: 100 }))).toEqual(['five_hour', 'overage']);
    expect(keysOf('claude', overage({ status: 'rejected', resets_at: '2026-12-01T00:00:00Z' }))).toEqual(['five_hour', 'overage']);
  });
  it('keeps status-only rejections of other windows and providers', () => {
    expect(keysOf('claude', { key: 'seven_day', status: 'rejected' })).toEqual(['five_hour', 'seven_day']);
    expect(keysOf('codex', overage({ status: 'rejected' }))).toEqual(['five_hour', 'overage']);
  });
});

describe('credential label', () => {
  it('defaults to the email domain', () => expect(labelOf({ email: 'someone@example.com', label: 'someone@example.com' })).toBe('example.com'));
  it('prefers the note', () => expect(labelOf({ email: 'someone@example.com', note: 'Work' })).toBe('Work'));
  it('falls back to the proxy label without an email', () => expect(labelOf({ label: 'API key' })).toBe('API key'));
  it('numbers labels shared within a provider, in id order', () => {
    const labels = parseUsageSnapshot({
      credentials: [
        { id: 'b', provider: 'claude', email: 'two@example.org' },
        { id: 'a', provider: 'claude', email: 'one@example.org' },
        { id: 'c', provider: 'codex', email: 'three@example.org' },
        { id: 'd', provider: 'claude', email: 'four@example.com' },
      ],
    }).credentials.map((c) => c.label);
    expect(labels).toEqual(['example.org 2', 'example.org 1','example.org', 'example.com']);
  });
});

describe('credential refresh capability', () => {
  it('honors the proxy capability for Claude and Antigravity', () => {
    expect(parseOne({ can_refresh: false }).canRefresh).toBe(false);
    expect(parseOne({ provider: 'antigravity', can_refresh: true }).canRefresh).toBe(true);
    expect(parseOne({ provider: 'antigravity', can_refresh: false }).canRefresh).toBe(false);
  });

  it('falls back to enabled Claude and Codex logins when the capability is omitted', () => {
    expect(parseOne({}).canRefresh).toBe(true);
    expect(parseOne({ provider: 'Codex' }).canRefresh).toBe(true);
    expect(parseOne({ provider: 'antigravity' }).canRefresh).toBe(false);
    expect(parseOne({ disabled: true }).canRefresh).toBe(false);
    expect(parseOne({ api_key: { masked: '••••' } }).canRefresh).toBe(false);
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
      .toEqual({ available: 1, applicable: 0, checkedAt: '2026-10-26T12:00:00Z', expiries: [] });
    expect(parseOne({ reset_credits: { available: 1, applicable: 3, checked_at: 'x' } }).resetCredits?.applicable).toBe(1);
    expect(parseOne({ reset_credits: null }).resetCredits).toBeNull();
    expect(parseOne({ reset_credits: { available: 2, applicable: 0, checked_at: 'x', expiries: ['2026-12-01T08:30:00Z', 'soon', 3, '2026-11-06T23:38:22Z'] } }).resetCredits?.expiries)
      .toEqual(['2026-11-06T23:38:22Z', '2026-12-01T08:30:00Z']);
    expect(parseOne({}).resetCredits).toBeNull();
  });
  it('drops an unknown cadence', () => {
    expect(parseOne({ windows: [{ key: 'k', reset_cadence: 'monthly' }] }).windows[0]!.resetCadence).toBeNull();
  });
  it('preserves distinct reset grants and disables unknown or malformed scope data', () => {
    const grant = { id: 'fable', label: 'Fable reset', scope: 'fable', available: 2, applicable: 2,
      expires_at: '2027-03-09T07:59:00Z', clears: ['five_hour', 'seven_day_overage_included'], gives_back_weekly: true, unavailable_reason: null };
    const credits = parseOne({ reset_credits: { available: 4, applicable: 4, checked_at: '2026-11-15T12:00:00Z', grants: [
      grant, { ...grant, id: 'general', scope: 'general', gives_back_weekly: false },
      { ...grant, id: 'unknown', scope: 'new_scope' }, { ...grant, id: 'bad-expiry', expires_at: 'invalid' },
      { ...grant, id: '', available: 1 }, { ...grant, id: 'bad-count', available: -1 },
    ] } }).resetCredits!;
    expect(credits.grants).toHaveLength(4);
    expect(credits.grants![0]).toEqual({ id: 'fable', label: 'Fable reset', scope: 'fable', available: 2, applicable: 2,
      expiresAt: grant.expires_at, clears: grant.clears, givesBackWeekly: true, unavailableReason: null });
    expect(credits.grants![1]).toMatchObject({ id: 'general', scope: 'general', givesBackWeekly: false });
    expect(credits.grants![2]).toMatchObject({ scope: 'unknown', applicable: 0 });
    expect(credits.grants![3]).toMatchObject({ expiresAt: null, applicable: 0 });
    expect(parseOne({ reset_credits: { available: 1, checked_at: 'x', grants: null } }).resetCredits?.grants).toEqual([]);
  });
});
