import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

vi.mock('electron', () => ({ app: { commandLine: { getSwitchValue: () => '' } } }));

import { parseProductionProxy } from './proxyIdentity';

const config = {
  access: { 'api-keys': ['production-key', 'other-key'] },
  management: { 'secret-key': 'management-key' },
  oauth: { 'auth-dir': 'C:\\data\\Spillway\\proxy\\auths' },
};

describe('parseProductionProxy', () => {
  it('reads the identity with client keys in order', () => {
    expect(parseProductionProxy(stringify(config))).toEqual({
      clientApiKeys: ['production-key', 'other-key'],
      managementSecret: 'management-key',
      authDir: config.oauth['auth-dir'],
    });
  });

  it('passes through a bcrypt management secret', () => {
    const hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    expect(parseProductionProxy(stringify({ ...config, management: { 'secret-key': hash } }))?.managementSecret).toBe(hash);
  });

  it('rejects a missing secret, empty key list, missing auth directory or invalid YAML', () => {
    for (const text of [
      stringify({ ...config, management: {} }),
      stringify({ ...config, access: { 'api-keys': [] } }),
      stringify({ ...config, oauth: {} }),
      'access: [unclosed',
    ]) expect(parseProductionProxy(text)).toBeNull();
  });
});
