import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, proxyConfigChanged } from './settings';

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
