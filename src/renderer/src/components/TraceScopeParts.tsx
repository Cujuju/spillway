import { shownText } from '../store';
import { conversationLabel } from '../lib/conversationNames';
import { HoverTip } from './ChartTip';
import { ChoiceChip, ScopeChip, ScopeField } from './ScopeChip';

export type TraceSort = 'cost' | 'failed' | 'recent';
/** The Traces view's own filters; the usage source and time frame are the sentence's other phrases. */
export interface TraceFilters { sort: TraceSort; text?: string; nodeId?: string; parentSessionId?: string }
export const DEFAULT_TRACE_FILTERS: TraceFilters = { sort: 'recent' };
/** A patch that clears every filter; spreading DEFAULT_TRACE_FILTERS alone would keep set keys. */
export const RESET_TRACE_FILTERS: Partial<TraceFilters> = { ...DEFAULT_TRACE_FILTERS, text: undefined, nodeId: undefined, parentSessionId: undefined };
const SESSION_NODE = 'session:';
const SORTS = [
  { value: 'recent', label: 'Most recent', phrase: 'most recent' },
  { value: 'cost', label: 'Cost', phrase: 'cost' },
  { value: 'failed', label: 'Failures', phrase: 'failures' },
] as const;

export const traceFiltersNarrowed = (f: TraceFilters) => f.sort !== DEFAULT_TRACE_FILTERS.sort || !!f.text || !!f.nodeId || !!f.parentSessionId;
/** The node for one exact session ID. */
export const sessionNode = (sessionId: string) => `${SESSION_NODE}${sessionId}`;

/** The Traces row cap, beside the sentence; hover explains it. */
export function TraceLimitNote(props: { limit: number }) {
  return (
    <HoverTip title="Request limit" rows={[{ label: 'Shown', value: `Newest ${props.limit.toLocaleString()}` }, { label: 'Totals', value: 'Partial' }]}
      note="Narrow the time frame or pick one session for complete totals.">
      <span class="badge compact amber trace-limit">Newest {props.limit.toLocaleString()} only</span>
    </HoverTip>
  );
}

/** "in [session] matching [text] ranked by [sort]": the Traces filters as sentence phrases. Text also searches recorded request and response bodies. */
export function TraceScopeParts(props: { value: TraceFilters; onChange: (patch: Partial<TraceFilters>) => void }) {
  const sessionId = () => (props.value.nodeId?.startsWith(SESSION_NODE) ? props.value.nodeId.slice(SESSION_NODE.length) : '');
  const session = () => {
    const v = props.value;
    if (v.parentSessionId) return `children of ${shownText(conversationLabel(v.parentSessionId))}`;
    if (v.nodeId) return shownText(sessionId() ? conversationLabel(sessionId()) : v.nodeId);
    return 'any session';
  };
  return (
    <>
      <span>in</span>
      <ScopeChip label="Session" value={session()} active={!!props.value.nodeId || !!props.value.parentSessionId}
        onClear={() => props.onChange({ nodeId: undefined, parentSessionId: undefined })}>
        <ScopeField label="Exact session ID" placeholder="Session ID" first value={sessionId()}
          onInput={(v) => props.onChange({ nodeId: v.trim() ? sessionNode(v.trim()) : undefined, parentSessionId: undefined })} />
      </ScopeChip>
      <span>matching</span>
      <ScopeChip label="Search" value={props.value.text ? `“${props.value.text}”` : 'anything'} active={!!props.value.text}
        onClear={() => props.onChange({ text: undefined })}>
        <ScopeField label="Sessions, models, effort or recorded text" placeholder="Search" search first value={props.value.text ?? ''}
          onInput={(v) => props.onChange({ text: v || undefined })} />
      </ScopeChip>
      <span>ranked by</span>
      <ChoiceChip label="Rank by" value={props.value.sort} initial={DEFAULT_TRACE_FILTERS.sort} options={SORTS} onChange={(sort) => props.onChange({ sort })} />
    </>
  );
}
