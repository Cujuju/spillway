import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_TRAY_LOOK, normalizeSettings, proxyConfigChanged } from './settings';

describe('normalizeSettings', () => {
  it('keeps only non-empty string account overrides', () => {
    const s = normalizeSettings({ proxy: { preferredAccounts: { claude: 'abc', codex: '', devin: 3 } } });
    expect(s.proxy.preferredAccounts).toEqual({ claude: 'abc' });
  });

  it('clamps the first-byte timeout and allows 0 (off)', () => {
    expect(normalizeSettings({ proxy: { firstByteTimeoutSeconds: 0 } }).proxy.firstByteTimeoutSeconds).toBe(0);
    expect(normalizeSettings({ proxy: { firstByteTimeoutSeconds: 99_999 } }).proxy.firstByteTimeoutSeconds).toBe(600);
    expect(normalizeSettings({}).proxy.firstByteTimeoutSeconds).toBe(DEFAULT_SETTINGS.proxy.firstByteTimeoutSeconds);
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

  it('defaults update auto-check on and keeps a stored choice', () => {
    expect(normalizeSettings({}).updates.autoCheck).toBe(true);
    expect(normalizeSettings({ updates: { autoCheck: false } }).updates.autoCheck).toBe(false);
  });
});

describe('proxyConfigChanged', () => {
  const withProxy = (p: Partial<typeof DEFAULT_SETTINGS.proxy>) => ({ ...DEFAULT_SETTINGS, proxy: { ...DEFAULT_SETTINGS.proxy, ...p } });

  it('is true for settings written to config.yaml', () => {
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ strategy: 'round-robin' }))).toBe(true);
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ firstByteTimeoutSeconds: 30 }))).toBe(true);
  });

  it('ignores the account override, which goes through the management API', () => {
    expect(proxyConfigChanged(DEFAULT_SETTINGS, withProxy({ preferredAccounts: { claude: 'abc' } }))).toBe(false);
  });
});
