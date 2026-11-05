import { expect, it } from 'vitest';
import { activityTransport, normalizeTransport, transportReason, transportRows, transportState } from './activityTransport';

it('keeps unknown historical and unsupported transports unknown', () => {
  expect(normalizeTransport({})).toEqual({ downstreamTransport: null, upstreamTransport: null, transportFallbackReason: null });
  for (const value of [false, 1, 'sse', 'CodexWebsocketsExecutor', 'HTTP']) expect(activityTransport(value)).toBeNull();
  expect(transportRows({}).map((r) => r.value)).toEqual(['Unknown', 'Unknown', 'Unknown']);
});

it('separates failed upgrades from an observed HTTP fallback', () => {
  expect(transportState({ upstreamTransport: 'websocket', transportFallbackReason: 'websocket_upgrade_401' }))
    .toBe('WebSocket upgrade rejected (HTTP 401)');
  expect(transportState({ upstreamTransport: 'websocket+http', transportFallbackReason: 'websocket_upgrade_426' }))
    .toBe('WebSocket upgrade rejected (HTTP 426); HTTP fallback attempted');
  expect(transportState({ upstreamTransport: 'http' })).toBe('No fallback observed');
  expect(transportReason('raw error: secret prompt')).toBeNull();
  expect(transportReason('x'.repeat(100))).toBeNull();
});
