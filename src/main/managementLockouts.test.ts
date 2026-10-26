import { describe, expect, it } from 'vitest';
import { parseLockouts } from './managementClient';

describe('parseLockouts', () => {
  it('reads locked and counting rows and drops malformed ones', () => {
    const data = {
      lockouts: [
        { ip: '127.0.0.1', failures: 0, failures_allowed: 3, locked_until: '2026-10-26T19:30:00Z', lockouts: 1 },
        { ip: '::1', failures: 2, failures_allowed: 5, locked_until: null, lockouts: 0 },
        { ip: 42, failures: 1, failures_allowed: 5 },
      ],
    };
    expect(parseLockouts(data)).toEqual([
      { ip: '127.0.0.1', failures: 0, failuresAllowed: 3, lockedUntil: '2026-10-26T19:30:00Z' },
      { ip: '::1', failures: 2, failuresAllowed: 5, lockedUntil: null },
    ]);
  });

  it('returns nothing for an unexpected body', () => {
    expect(parseLockouts(null)).toEqual([]);
    expect(parseLockouts({ lockouts: 'no' })).toEqual([]);
  });
});
