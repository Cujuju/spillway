import type { CaptureState } from '@shared/archive';
import type { TraceAttempt, TraceNode, TraceParent } from '@shared/sessionTrace';
import type { SessionKind } from '@shared/types';
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

/** How a session began, where the kind badge and parent row don't already say it. */
export const ORIGIN_BADGE: Partial<Record<SessionKind, { label: string; tone: Tone }>> = {
  fork: { label: 'Fork', tone: '' },
  compaction: { label: 'Compaction', tone: '' },
};

export const PARENT_LINK: Record<TraceParent['kind'], string> = {
  subagent: 'Subagent',
  fork: 'Fork',
  compaction: 'Compaction',
  unknown: 'Unclassified',
};

export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  root: 'Root',
  subagent: 'Subagent',
  fork: 'Fork',
  compaction: 'Compaction',
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

/** Where an attempt's captured exchange opens: a side panel over the session card, or under its row. */
export const EXCHANGE_LAYOUTS = ['panel', 'inline'] as const;
export type ExchangeLayout = (typeof EXCHANGE_LAYOUTS)[number];
export const EXCHANGE_LAYOUT_OPTIONS: readonly { value: ExchangeLayout; label: string; title: string }[] = [
  { value: 'panel', label: 'Panel', title: 'Open exchanges in a side panel' },
  { value: 'inline', label: 'Inline', title: 'Open exchanges under their row' },
];

/** Capture reasons the app writes (archiveStore.ts), in words. The proxy can send others; those show as sent. */
const CAPTURE_REASON: Record<string, string> = {
  'metadata-only': 'Record bodies was off.',
  'capture-disabled': 'Record bodies was turned off before the capture finished.',
  'awaiting-finalization': 'Waiting for the proxy to finish the capture.',
  'websocket-open': 'The WebSocket is still open; its messages update here.',
  'archive-reopened-before-finalization': 'The app restarted before the capture finished.',
  'proxy-restarted-before-capture': 'The proxy restarted before handing over the capture.',
  'capture-unavailable-or-interrupted': 'The capture never arrived or was interrupted.',
  'retention-or-byte-budget': 'Removed by retention or the byte budget; the identity remains.',
};
/** Reasons meaning text was never recorded because Record bodies was off. */
export const RECORDING_OFF_REASONS: ReadonlySet<string> = new Set(['metadata-only', 'capture-disabled']);
export const captureReasonText = (reason: string) => CAPTURE_REASON[reason] ?? reason;
