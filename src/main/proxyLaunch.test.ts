import { createServer, type Server } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./paths', () => ({ appPaths: {}, USER_CONFIG_NAME: 'config.user.yaml' }));
vi.mock('./settingsStore', () => ({}));

const { newSupervisorPassword, portInUse } = await import('./proxyLaunch');

/** Proxy minimum (handler.go MinSupervisorPasswordLength). */
const PROXY_MIN_PASSWORD_LENGTH = 32;

const listen = (host: string) =>
  new Promise<Server>((resolve) => {
    const server = createServer();
    server.listen({ port: 0, host }, () => resolve(server));
  });
const portOf = (s: Server) => (s.address() as { port: number }).port;
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe('portInUse', () => {
  it('detects a loopback listener and a wildcard listener', async () => {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const server = await listen(host);
      const port = portOf(server);
      expect(await portInUse(port, false)).toBe(true);
      await close(server);
      expect(await portInUse(port, false)).toBe(false);
    }
  });
});

describe('newSupervisorPassword', () => {
  it('meets the proxy minimum and differs per launch', () => {
    const a = newSupervisorPassword();
    expect(a.length).toBeGreaterThanOrEqual(PROXY_MIN_PASSWORD_LENGTH);
    expect(newSupervisorPassword()).not.toBe(a);
  });
});
