import { afterEach, expect, it, vi } from 'vitest';
import { management, UsageRefreshError } from './managementClient';

afterEach(() => vi.unstubAllGlobals());

it('reports per-account failures from HTTP 200 and preserves successful account data', async () => {
  management.configure('http://127.0.0.1:8317', 'test-management');
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    credentials: [{ id: 'a', provider: 'claude', windows: [{ key: 'five_hour', used_percent: 42 }] }],
    errors: { 'failed-account': 'HTTP 429', 'another-account': 'HTTP 429' },
  })));
  vi.stubGlobal('fetch', fetch);
  const error = await management.refreshUsage().catch((err: unknown) => err);
  expect(error).toBeInstanceOf(UsageRefreshError);
  const failure = error as UsageRefreshError;
  expect(failure.message).toBe('Could not refresh 2 account(s): HTTP 429');
  expect(failure.message).not.toContain('failed-account');
  expect(failure.snapshot.credentials[0]?.windows[0]?.usedPercent).toBe(42);
});

it('returns successful refreshes normally and targets the selected account', async () => {
  management.configure('http://127.0.0.1:8317', 'test-management');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ strategy: 'soonest-reset', credentials: [], errors: {} })));
  vi.stubGlobal('fetch', fetch);
  expect(await management.refreshUsage('a')).toMatchObject({ strategy: 'soonest-reset', credentials: [] });
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8317/v8/management/usage/refresh', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ auth_index: 'a' }),
  }));
});
