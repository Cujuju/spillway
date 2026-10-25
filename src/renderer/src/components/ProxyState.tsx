import type { ProxyState } from '@shared/types';
import { compactDuration } from '../lib/format';
import { now, proxyStatus } from '../store';

const LABELS: Record<ProxyState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  crashed: 'Crashed',
  'missing-binary': 'Not installed',
  'port-busy': 'Port in use',
};

const TONES: Record<ProxyState, string> = {
  stopped: '',
  starting: 'amber',
  running: 'green',
  stopping: 'amber',
  crashed: 'red',
  'missing-binary': 'red',
  'port-busy': 'red',
};

/** compactDuration's smallest unit is a minute. */
const UPTIME_MIN_MS = 60_000;

const proxyState = () => proxyStatus()?.state ?? 'stopped';

/** e.g. "Proxy running · up 3h 12m". */
export function proxyStatusText(): string {
  const label = `Proxy ${LABELS[proxyState()].toLowerCase()}`;
  const started = proxyStatus()?.startedAt;
  if (proxyState() !== 'running' || !started) return label;
  const ms = now() - Date.parse(started);
  return `${label} · ${ms < UPTIME_MIN_MS ? 'just started' : `up ${compactDuration(ms)}`}`;
}

/** The app's one proxy status indicator; sits on the sidebar's Proxy item. */
export function ProxyStateDot() {
  return <span class={`status-dot ${TONES[proxyState()]}`} role="img" aria-label={proxyStatusText()} />;
}
