import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { buildProxyConfig } from './proxyConfig';

const base = {
  managementKey: 'mgmt"key',
  clientApiKey: 'client-key',
  authDir: 'C:\\data\\proxy\\auths',
};

describe('buildProxyConfig', () => {
  it('binds loopback and writes routing from settings', () => {
    const yaml = buildProxyConfig({ ...base, settings: DEFAULT_SETTINGS.proxy });
    expect(yaml).toContain('  host: "127.0.0.1"');
    expect(yaml).toContain('  port: 8317');
    expect(yaml).toContain('  strategy: "soonest-reset"');
    expect(yaml).toContain('  session-affinity: true');
    expect(yaml).toContain('  session-affinity-ttl: "60m"');
  });

  it('escapes quotes and backslashes as YAML double-quoted scalars', () => {
    const yaml = buildProxyConfig({ ...base, settings: DEFAULT_SETTINGS.proxy });
    expect(yaml).toContain('  secret-key: "mgmt\\"key"');
    expect(yaml).toContain('  auth-dir: "C:\\\\data\\\\proxy\\\\auths"');
  });

  it('binds all interfaces only when LAN access is on', () => {
    const yaml = buildProxyConfig({ ...base, settings: { ...DEFAULT_SETTINGS.proxy, allowLan: true } });
    expect(yaml).toContain('  host: ""');
  });
});
