import { shownText } from '../store';
import { conversationLabel } from '../lib/conversationNames';
import { HoverTip } from './ChartTip';
import { ChoiceChip, ScopeChip } from './ScopeChip';

export type TraceSort = 'cost' | 'failed' | 'recent';
/** The Traces view's own filters; the usage source and time frame are the sentence's other phrases. */
export interface TraceFilters { sort: TraceSort; text?: string; nodeId?: string; parentSessionId?: string }
export const DEFAULT_TRACE_FILTERS: TraceFilters = { sort: 'cost' };
/** A patch that clears every filter; spreading DEFAULT_TRACE_FILTERS alone would keep set keys. */
export const RESET_TRACE_FILTERS: Partial<TraceFilters> = { ...DEFAULT_TRACE_FILTERS, text: undefined, nodeId: undefined, parentSessionId: undefined };
const SESSION_NODE = 'session:';
const SORTS = [
  { value: 'cost', label: 'Cost', phrase: 'cost' },
  { value: 'failed', label: 'Failures', phrase: 'failures' },
  { value: 'recent', label: 'Most recent', phrase: 'most recent' },
] as const;

export const traceFiltersNarrowed = (f: TraceFilters) => f.sort !== DEFAULT_TRACE_FILTERS.sort || !!f.text || !!f.nodeId || !!f.parentSessionId;
/** The node for one exact session ID. */
export const sessionNode = (sessionId: string) => `${SESSION_NODE}${sessionId}`;

const closeOnEnter = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
  if (e.key === 'Enter') e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
};

/** The Traces row cap, beside the sentence; hover explains it. */
export function TraceLimitNote(props: { limit: number }) {
  return (
    <HoverTip title="Request limit" rows={[{ label: 'Shown', value: `Newest ${props.limit.toLocaleString()}` }, { label: 'Totals', value: 'Partial' }]}
      note="Narrow the time frame or pick one session for complete totals.">
      <span class="badge compact amber trace-limit">Newest {props.limit.toLocaleString()} only</span>
    </HoverTip>
  );
}

/** "in [session] matching [text] ranked by [sort]": the Traces filters as sentence phrases. */
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
        <label class="scope-field">
          <span>Exact session ID</span>
          <input class="input" autofocus placeholder="Session ID" value={sessionId()} onKeyDown={closeOnEnter}
            onInput={(e) => props.onChange({ nodeId: e.currentTarget.value.trim() ? sessionNode(e.currentTarget.value.trim()) : undefined, parentSessionId: undefined })} />
        </label>
      </ScopeChip>
      <span>matching</span>
      <ScopeChip label="Search" value={props.value.text ? `“${props.value.text}”` : 'anything'} active={!!props.value.text}
        onClear={() => props.onChange({ text: undefined })}>
        <label class="scope-field">
          <span>Sessions, models or effort</span>
          <input class="input" type="search" autofocus placeholder="Search" value={props.value.text ?? ''} onKeyDown={closeOnEnter}
            onInput={(e) => props.onChange({ text: e.currentTarget.value || undefined })} />
        </label>
      </ScopeChip>
      <span>ranked by</span>
      <ChoiceChip label="Rank by" value={props.value.sort} initial={DEFAULT_TRACE_FILTERS.sort} options={SORTS} onChange={(sort) => props.onChange({ sort })} />
    </>
  );
}
