import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_TRAY_LOOK, normalizeSettings, proxyConfigChanged } from './settings';

describe('normalizeSettings', () => {
  it('defaults and validates the optional Rhythm ZIP format', () => {
    expect(normalizeSettings({}).activity.zipCode).toBe('');
    expect(normalizeSettings({ activity: { zipCode: ' 00601 ' } }).activity.zipCode).toBe('00601');
    for (const zipCode of [12345, '1234', '123456', 'abcde']) {
      expect(normalizeSettings({ activity: { zipCode } }).activity.zipCode).toBe('');
    }
  });

  it('keeps only non-empty string account overrides', () => {
    const s = normalizeSettings({ proxy: { preferredAccounts: { claude: 'abc', codex: '', devin: 3 } } });
    expect(s.proxy.preferredAccounts).toEqual({ claude: 'abc' });
  });

  it('clamps the first-byte timeout and allows 0 (off)', () => {
    expect(normalizeSettings({ proxy: { firstByteTimeoutSeconds: 0 } }).proxy.firstByteTimeoutSeconds).toBe(0);
    expect(normalizeSettings({ proxy: { firstByteTimeoutSeconds: 99_999 } }).proxy.firstByteTimeoutSeconds).toBe(600);
    expect(normalizeSettings({}).proxy.firstByteTimeoutSeconds).toBe(DEFAULT_SETTINGS.proxy.firstByteTimeoutSeconds);
  });

  it('clamps the usage lookup settle delay and allows 0 (off)', () => {
    expect(normalizeSettings({ proxy: { usageLookupSettleSeconds: 0 } }).proxy.usageLookupSettleSeconds).toBe(0);
    expect(normalizeSettings({ proxy: { usageLookupSettleSeconds: 99_999 } }).proxy.usageLookupSettleSeconds).toBe(900);
    expect(normalizeSettings({}).proxy.usageLookupSettleSeconds).toBe(60);
  });

  it('keeps a valid tray icon look and resets invalid parts to the default', () => {
    const item = (look: unknown) => normalizeSettings({ trayIcons: { items: [{ provider: 'claude', windowKey: 'five_hour', look }] } }).trayIcons.items[0]!.look;
    expect(item({ shape: 'circle', fill: 'filled', color: '#AABBCC' })).toEqual({ shape: 'circle', fill: 'filled', color: '#aabbcc' });
    expect(item({ shape: 'rounded', fill: 'outline', color: null }).shape).toBe('rounded');
    expect(item({ shape: 'hexagon', fill: 'glow', color: 'red' })).toEqual(DEFAULT_TRAY_LOOK);
    expect(item(undefined)).toEqual(DEFAULT_TRAY_LOOK);
  });

  it('keeps only #rrggbb saved colours', () => {
    expect(normalizeSettings({ trayIcons: { savedColors: ['#112233', '#12345678', 4, 'blue'] } }).trayIcons.savedColors).toEqual(['#112233']);
  });

  it('defaults the sidebar expanded and keeps a stored choice', () => {
    expect(normalizeSettings({}).general.sidebarCollapsed).toBe(false);
    expect(normalizeSettings({ general: { sidebarCollapsed: true } }).general.sidebarCollapsed).toBe(true);
    expect(normalizeSettings({ general: { sidebarCollapsed: 'yes' } }).general.sidebarCollapsed).toBe(false);
  });

  it('defaults API keys last and keeps only a valid stored order', () => {
    expect(normalizeSettings({}).proxy.apiKeyOrder).toBe('last');
    expect(normalizeSettings({ proxy: { apiKeyOrder: 'first' } }).proxy.apiKeyOrder).toBe('first');
    expect(normalizeSettings({ proxy: { apiKeyOrder: 'middle' } }).proxy.apiKeyOrder).toBe('last');
    expect(normalizeSettings({}).proxy.serverErrors).toBe('stay');
    expect(normalizeSettings({ proxy: { serverErrors: 'switch' } }).proxy.serverErrors).toBe('switch');
    expect(normalizeSettings({ proxy: { serverErrors: 'panic' } }).proxy.serverErrors).toBe('stay');
  });

  it('defaults update auto-check on and keeps a stored choice', () => {
    expect(normalizeSettings({}).updates.autoCheck).toBe(true);
    expect(normalizeSettings({ updates: { autoCheck: false } }).updates.autoCheck).toBe(false);
  });

  it('defaults the update channel to stable and drops unknown ones', () => {
    expect(normalizeSettings({}).updates.channel).toBe('stable');
    expect(normalizeSettings({ updates: { channel: 'nightly' } }).updates.channel).toBe('nightly');
    expect(normalizeSettings({ updates: { channel: 'beta' } }).updates.channel).toBe('stable');
  });
});

describe('forecastHours', () => {
  it('migrates the old whole-day setting to hours', () => {
    expect(normalizeSettings({ dashboard: { forecastDays: 3 } }).dashboard.forecastHours).toBe(72);
  });

  it('keeps a stored hour length over the old day setting', () => {
    expect(normalizeSettings({ dashboard: { forecastHours: 4, forecastDays: 3 } }).dashboard.forecastHours).toBe(4);
  });
});

describe('proxyConfigChanged', () => {
  const withProxy = (p: Partial<typeof DEFAULT_SETTINGS.proxy>) => ({ ...DEFAULT_SETTINGS, proxy: { ...DEFAULT_SETTINGS.proxy, ...p } });

  it('is true for settings written to config.yaml', () => {
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ strategy: 'round-robin' }))).toBe(true);
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ firstByteTimeoutSeconds: 30 }))).toBe(true);
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ usageLookupSettleSeconds: 30 }))).toBe(true);
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ apiKeyOrder: 'first' }))).toBe(true);
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ serverErrors: 'switch' }))).toBe(true);
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ requestLog: true }))).toBe(true);
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ sessionHoldMinutes: 45 }))).toBe(true);
  });

  it('ignores the account override, which goes through the management API', () => {
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ preferredAccounts: { claude: 'abc' } }))).toBe(false);
  });
});
