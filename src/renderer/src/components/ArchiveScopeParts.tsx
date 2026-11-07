import { For } from 'solid-js';
import type { CaptureState } from '@shared/archive';
import { shownText } from '../store';
import { conversationLabel } from '../lib/conversationNames';
import type { ArchiveFilters } from '../lib/archiveViewQuery';
import { CAPTURE_LABEL } from '../lib/traceFormat';
import { ChoiceChip, ScopeChip, ScopeField } from './ScopeChip';

/** The state chip's "any state" value; ArchiveFilters holds it as undefined. */
const ANY_STATE = '';
const STATES: readonly { value: CaptureState | typeof ANY_STATE; label: string; phrase: string }[] = [
  { value: ANY_STATE, label: 'Any capture', phrase: 'any capture' },
  { value: 'complete', label: CAPTURE_LABEL.complete, phrase: 'full capture' },
  { value: 'partial', label: CAPTURE_LABEL.partial, phrase: 'partial capture' },
  { value: 'pending', label: CAPTURE_LABEL.pending, phrase: 'pending capture' },
  { value: 'missing', label: CAPTURE_LABEL.missing, phrase: 'metadata only' },
  { value: 'expired', label: CAPTURE_LABEL.expired, phrase: 'expired bodies' },
];
const ORIGIN_FIELDS = [['model', 'Model'], ['provider', 'Provider'], ['client', 'Client']] as const;

const typed = (v: string) => v.trim() || undefined;

/** "in [conversation] from [model] matching [text] with [capture]": the Archive filters as sentence phrases. Fields match exactly, except text. */
export function ArchiveScopeParts(props: { value: ArchiveFilters; onChange: (patch: Partial<ArchiveFilters>) => void }) {
  const origin = () => ORIGIN_FIELDS.map(([key]) => props.value[key]).filter(Boolean).map((v) => shownText(v!)).join(' · ');
  return (
    <>
      <span>in</span>
      <ScopeChip label="Conversation" value={props.value.sessionId ? shownText(conversationLabel(props.value.sessionId)) : 'any conversation'} active={!!props.value.sessionId}
        onClear={() => props.onChange({ sessionId: undefined })}>
        <ScopeField label="Exact conversation ID" placeholder="Session ID" first value={props.value.sessionId ?? ''} onInput={(v) => props.onChange({ sessionId: typed(v) })} />
      </ScopeChip>
      <span>from</span>
      <ScopeChip label="Model" value={origin() || 'any model'} active={!!origin()}
        onClear={() => props.onChange({ model: undefined, provider: undefined, client: undefined })}>
        <For each={ORIGIN_FIELDS}>{([key, label], i) => (
          <ScopeField label={label} placeholder={`Exact ${label.toLowerCase()}`} first={i() === 0} value={props.value[key] ?? ''} onInput={(v) => props.onChange({ [key]: typed(v) })} />
        )}</For>
      </ScopeChip>
      <span>matching</span>
      <ScopeChip label="Search" value={props.value.text ? `“${shownText(props.value.text)}”` : 'anything'} active={!!props.value.text}
        onClear={() => props.onChange({ text: undefined })}>
        <ScopeField label="Recorded request and response text" placeholder="Search" search first value={props.value.text ?? ''} onInput={(v) => props.onChange({ text: v || undefined })} />
      </ScopeChip>
      <span>with</span>
      <ChoiceChip label="Capture" value={props.value.state ?? ANY_STATE} initial={ANY_STATE} options={STATES}
        onChange={(v) => props.onChange({ state: v || undefined })} />
    </>
  );
}
