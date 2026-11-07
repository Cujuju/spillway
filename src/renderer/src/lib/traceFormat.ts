import type { CaptureState } from '@shared/archive';
import type { TraceAttempt, TraceNode } from '@shared/sessionTrace';
import { conversationLabel } from './conversationNames';
import { msDuration, usd } from './format';

/** Badge tones from components.css; '' is the neutral badge. */
export type Tone = '' | 'green' | 'amber' | 'red' | 'accent';

/** Characters of a trace or attempt ID shown where no conversation names the node. */
const SHORT_ID_CHARS = 10;
const NODE_PREFIX = /^(session|trace|attempt):/;

export const costText = (usdValue: number | null) => (usdValue === null ? '—' : usd(usdValue));

/** A conversation's title or short ID; exchanges without a session read by their trace or attempt ID. */
export function nodeLabel(n: Pick<TraceNode, 'id' | 'sessionId'>): string {
  if (n.sessionId) return conversationLabel(n.sessionId);
  const [, kind = 'attempt'] = n.id.match(NODE_PREFIX) ?? [];
  return `${kind === 'trace' ? 'Exchange' : 'Attempt'} ${n.id.replace(NODE_PREFIX, '').slice(0, SHORT_ID_CHARS)}`;
}

const MODEL_ROUTE = ' → ';
/** Node models arrive as "requested → effective"; a route to itself reads as one name. */
export function modelLabel(route: string): string {
  const [requested, effective] = route.split(MODEL_ROUTE);
  return effective && effective !== requested ? route : (requested ?? route);
}

export const KIND_BADGE: Record<TraceNode['kind'], { label: string; tone: Tone }> = {
  session: { label: 'Session', tone: '' },
  subagent: { label: 'Subagent', tone: 'accent' },
  unassigned: { label: 'No session', tone: 'amber' },
};

/** Average of measured samples; null when none. */
export const meanMs = (sum: number, count: number) => (count ? sum / count : null);
export const meanText = (sum: number, count: number) => msDuration(meanMs(sum, count));

export function attemptStatus(a: Pick<TraceAttempt, 'failed' | 'statusCode'>): { label: string; tone: Tone } {
  if (a.failed === true) return { label: a.statusCode ? `Failed ${a.statusCode}` : 'Failed', tone: 'red' };
  if (a.failed === false) return { label: a.statusCode ? String(a.statusCode) : 'OK', tone: 'green' };
  return { label: a.statusCode ? String(a.statusCode) : 'No status', tone: '' };
}

export const CAPTURE_TONE: Record<CaptureState, Tone> = {
  complete: 'green',
  partial: 'amber',
  pending: 'accent',
  missing: '',
  expired: '',
  unknown: '',
};

export const CAPTURE_LABEL: Record<CaptureState, string> = {
  complete: 'Captured',
  partial: 'Partial',
  pending: 'Pending',
  missing: 'Metadata only',
  expired: 'Expired',
  unknown: 'Not retained',
};
