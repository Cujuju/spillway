import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { buildProxyConfig, OVERLOAD_RULE } from './proxyConfig';

const base = {
  clientApiKey: 'client"key',
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
      'session-affinity-persist': true, cooldown: { 'save-cooldown-status': true } });
    expect(cfg.requests.streaming['first-byte-timeout-seconds']).toBe(90);
    expect(cfg.oauth['auth-dir']).toBe('C:\\data\\proxy\\auths');
    expect(cfg.access['api-keys']).toEqual(appKeys);
  });

  it('writes the stable management key for outside tools; the app itself uses the supervisor password', () => {
    expect(parsed().management).toEqual({ 'secret-key': 'mk', 'allow-remote': false, 'disable-control-panel': true });
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
    expect(cfg.access['api-keys']).toEqual(['lan-key', ...appKeys]);
    expect(yaml).toContain('# my tweaks');
  });

  it("returns Claude overloads to the client instead of moving the conversation; a user's 529 rule wins", () => {
    const rules = (userConfig: string) => parse(build({ userConfig }).yaml).oauth['request-scoped-errors'].claude;
    expect(rules('')).toEqual([OVERLOAD_RULE]);
    const tooLong = { status: 400, match: ['prompt is too long'], action: 'stop' };
    const userRules = (...lines: string[]) => ['oauth:', '  request-scoped-errors:', '    claude:', ...lines].join('\n');
    expect(rules(userRules('      - status: 400', '        match: ["prompt is too long"]', '        action: stop'))).toEqual([OVERLOAD_RULE, tooLong]);
    expect(rules(userRules('      - status: 529', '        action: continue'))).toEqual([{ status: 529, action: 'continue' }]);
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
