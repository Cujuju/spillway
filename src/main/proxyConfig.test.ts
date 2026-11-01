import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { buildProxyConfig, TLS_HANDSHAKE_TIMEOUT_SECONDS } from './proxyConfig';

const base = {
  clientApiKeys: ['client"key'],
  managementKey: 'mk',
  authDir: 'C:\\data\\proxy\\auths',
  settings: DEFAULT_SETTINGS.proxy,
  userConfig: '',
};

/** Codex sends the pool token on account calls, so the proxy must accept it beside the client key. */
const appKeys = ['client"key'];

const build = (over: Partial<typeof base> = {}) => buildProxyConfig({ ...base, ...over });
const parsed = (over: Partial<typeof base> = {}) => parse(build(over).yaml);

describe('buildProxyConfig', () => {
  it('writes app-owned keys from settings', () => {
    const cfg = parsed();
    expect(cfg['config-version']).toBe(8);
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 8317 });
    expect(cfg.routing).toEqual({ strategy: 'soonest-reset', 'prefer-auth-kind': 'oauth', 'session-affinity': true, 'session-affinity-ttl': '60m',
      'session-affinity-hold': '0m', 'server-errors': 'return', 'session-affinity-rebind-on': 'quota', 'session-affinity-persist': true, cooldown: { 'save-cooldown-status': true } });
    expect(cfg.requests.streaming['first-byte-timeout-seconds']).toBe(90);
    expect(cfg['usage-lookups']['settle-seconds']).toBe(60);
    expect(cfg.requests['tls-handshake-timeout-seconds']).toBe(TLS_HANDSHAKE_TIMEOUT_SECONDS);
    expect(cfg.observability.logs['request-log']).toBe(false);
    expect(cfg.oauth['auth-dir']).toBe('C:\\data\\proxy\\auths');
    expect(cfg.access['api-keys']).toEqual(appKeys);
  });

  it('writes the stable management key for outside tools; the app itself uses the supervisor password', () => {
    expect(parsed().management).toEqual({ 'secret-key': 'mk', 'allow-remote': false, 'disable-control-panel': true });
  });

  it('switches accounts on server errors only when the setting says so', () => {
    expect(parsed({ settings: { ...DEFAULT_SETTINGS.proxy, serverErrors: 'switch' } }).routing['server-errors']).toBe('failover');
  });

  it('writes the configured usage lookup settle delay', () => {
    expect(parsed({ settings: { ...DEFAULT_SETTINGS.proxy, usageLookupSettleSeconds: 0 } })['usage-lookups']['settle-seconds']).toBe(0);
  });

  it('routes to API keys first only when the setting says so', () => {
    expect(parsed({ settings: { ...DEFAULT_SETTINGS.proxy, apiKeyOrder: 'first' } }).routing['prefer-auth-kind']).toBe('api-key');
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
    expect(cfg.access['api-keys']).toEqual([...appKeys, 'lan-key']);
    expect(yaml).toContain('# my tweaks');
  });

  it('puts app keys first in order and deduplicates user keys', () => {
    const cfg = parsed({ clientApiKeys: ['app-key', 'second-key'],
      userConfig: 'access:\n  api-keys: [user-key, second-key, app-key, user-key]' });
    expect(cfg.access['api-keys']).toEqual(['app-key', 'second-key', 'user-key']);
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
