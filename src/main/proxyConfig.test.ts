import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { buildProxyConfig } from './proxyConfig';

const base = {
  clientApiKey: 'client"key',
  managementKey: 'mk',
  authDir: 'C:\\data\\proxy\\auths',
  settings: DEFAULT_SETTINGS.proxy,
  userConfig: '',
};

const build = (over: Partial<typeof base> = {}) => buildProxyConfig({ ...base, ...over });
const parsed = (over: Partial<typeof base> = {}) => parse(build(over).yaml);

describe('buildProxyConfig', () => {
  it('writes app-owned keys from settings', () => {
    const cfg = parsed();
    expect(cfg['config-version']).toBe(8);
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 8317 });
    expect(cfg.routing).toEqual({ strategy: 'soonest-reset', 'session-affinity': true, 'session-affinity-ttl': '60m' });
    expect(cfg.requests.streaming['first-byte-timeout-seconds']).toBe(90);
    expect(cfg.oauth['auth-dir']).toBe('C:\\data\\proxy\\auths');
    expect(cfg.access['api-keys']).toEqual(['client"key']);
  });

  it('never writes a management key: the supervisor password comes from the environment', () => {
    expect(parsed().management).toEqual({ 'allow-remote': false, 'disable-control-panel': true });
  });

  it('binds all interfaces only when LAN access is on', () => {
    expect(parsed({ settings: { ...DEFAULT_SETTINGS.proxy, allowLan: true } }).server.host).toBe('');
  });

  it('keeps user keys and comments while app-owned keys win', () => {
    const userConfig = [
      '# my tweaks',
      'routing:',
      '  strategy: round-robin # replaced',
      '  retry:',
      '    request-retry: 3',
      'access:',
      '  api-keys: [lan-key]',
      'debug: true',
    ].join('\n');
    const { yaml, userConfigError } = build({ userConfig });
    const cfg = parse(yaml);
    expect(userConfigError).toBeNull();
    expect(cfg.routing.strategy).toBe('soonest-reset');
    expect(cfg.routing.retry).toEqual({ 'request-retry': 3 });
    expect(cfg.debug).toBe(true);
    expect(cfg.access['api-keys']).toEqual(['lan-key', 'client"key']);
    expect(yaml).toContain('# my tweaks');
  });

  it('ignores an unusable user file and reports why', () => {
    for (const userConfig of ['routing: [unclosed', '- a list', 'just text']) {
      const { yaml, userConfigError } = build({ userConfig });
      expect(userConfigError).toBeTruthy();
      expect(userConfigError).not.toContain('\n');
      expect(parse(yaml).server.port).toBe(8317);
    }
  });
});
