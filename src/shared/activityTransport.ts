export type ActivityTransport = 'http' | 'websocket' | 'websocket+http';

/** Optional for old records and metadata-only client-log imports. No transport is inferred. */
export interface TransportMetadata {
  downstreamTransport?: ActivityTransport | null;
  upstreamTransport?: ActivityTransport | null;
  transportFallbackReason?: string | null;
}

export const activityTransport = (v: unknown): ActivityTransport | null =>
  v === 'http' || v === 'websocket' || v === 'websocket+http' ? v : null;

/** The API sends bounded codes, never arbitrary upstream errors or payload text. */
export const transportReason = (v: unknown): string | null =>
  typeof v === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(v) ? v : null;

export const normalizeTransport = (e: TransportMetadata): Required<TransportMetadata> => ({
  downstreamTransport: activityTransport(e.downstreamTransport),
  upstreamTransport: activityTransport(e.upstreamTransport),
  transportFallbackReason: transportReason(e.transportFallbackReason),
});

export function transportLabel(v: ActivityTransport | null | undefined): string {
  if (v === 'http') return 'HTTP';
  if (v === 'websocket') return 'WebSocket';
  if (v === 'websocket+http') return 'WebSocket + HTTP';
  return 'Unknown';
}

export function transportState(e: TransportMetadata): string {
  const reason = transportReason(e.transportFallbackReason);
  const rejected = reason?.match(/^websocket_upgrade_(\d+)$/);
  const state = rejected ? `WebSocket upgrade rejected (HTTP ${rejected[1]})`
    : reason === 'websocket_dial_failed' ? 'WebSocket connection failed'
    : reason === 'websocket_dial_canceled' ? 'WebSocket connection canceled'
    : reason === 'websocket_dial_timeout' ? 'WebSocket connection timed out'
    : reason;
  if (state) return `${state}${e.upstreamTransport === 'websocket+http' ? '; HTTP fallback attempted' : ''}`;
  if (e.upstreamTransport === 'websocket+http') return 'Both transports attempted; reason unknown';
  return e.upstreamTransport ? 'No fallback observed' : 'Unknown';
}

export const transportRows = (e: TransportMetadata) => [
  { label: 'Client → proxy', value: transportLabel(e.downstreamTransport) },
  { label: 'Proxy → provider', value: transportLabel(e.upstreamTransport) },
  { label: 'Fallback / upgrade', value: transportState(e) },
];
