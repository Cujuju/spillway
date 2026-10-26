import { describe, expect, it } from 'vitest';
import { parseBuildInfo } from './buildInfo';

describe('parseBuildInfo', () => {
  it('reads a clean stamped build', () => {
    expect(parseBuildInfo('v8.0.42', '7a583832', '2026-10-26T12:00:00Z')).toEqual({
      version: 'v8.0.42', build: '7a583832', modified: false, builtAt: '2026-10-26T12:00:00Z',
    });
  });

  it('splits the modified marker off the hash', () => {
    expect(parseBuildInfo('0.26.0', 'eca685c-dirty', null)).toMatchObject({ build: 'eca685c', modified: true });
  });

  it('treats the proxy defaults as unstamped', () => {
    expect(parseBuildInfo('dev', 'none', 'unknown')).toEqual({ version: 'dev', build: null, modified: false, builtAt: null });
    expect(parseBuildInfo(null, undefined, null)).toEqual({ version: 'dev', build: null, modified: false, builtAt: null });
  });
});
