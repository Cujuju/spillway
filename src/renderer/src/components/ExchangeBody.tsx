import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { CAPTURE_BODY_LIMIT } from '@shared/archive';
import type { ExchangeMessage, ExchangePart, ExchangeSide } from '@shared/exchangeBody';
import { shownText } from '../store';
import { byteSize } from '../lib/format';
import { HoverTip } from './ChartTip';
import { Seg } from './ui';

/** Raw characters laid out per step; a 256 KiB body never renders at once. */
const RENDER_CHUNK = 32 * 1024;
/** Messages rendered per step; 50 long messages measured ~20 ms of layout, 20 stay within one frame. */
const MESSAGE_PAGE = 20;
/** Parts rendered per step within one message; same one-frame budget as MESSAGE_PAGE. */
const PART_PAGE = 20;
/** Characters of one message part shown before its own expander. */
const PART_PREVIEW = 2 * 1024;

type View = 'readable' | 'raw';
const VIEWS = [{ value: 'readable', label: 'Readable' }, { value: 'raw', label: 'Raw' }] as const;
const LIMIT_TEXT = byteSize(CAPTURE_BODY_LIMIT);
const CUT_NOTE = `The proxy records the first ${LIMIT_TEXT} of each side. Everything after that, often the newest messages, was not recorded.`;
const PART_LABEL: Record<ExchangePart['kind'], string> = { text: '', thinking: 'Thinking', 'tool-call': 'Tool call', 'tool-result': 'Tool result', media: 'Attachment' };

/** Long text shows a preview with its own expander, so one huge tool result can't swamp the list. */
function PartText(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  const text = createMemo(() => shownText(props.text));
  const long = () => text().length > PART_PREVIEW;
  return <>
    <div class="exchange-text">{open() || !long() ? text() : `${text().slice(0, PART_PREVIEW)}…`}</div>
    <Show when={long()}><button class="exchange-more" type="button" onClick={() => setOpen((v) => !v)}>{open() ? 'Show less' : `Show all ${text().length.toLocaleString()} characters`}</button></Show>
  </>;
}

function Part(props: { part: ExchangePart }) {
  const name = () => ('name' in props.part ? props.part.name : '');
  return <div class={`exchange-part ${props.part.kind}`}>
    <Show when={PART_LABEL[props.part.kind]}>
      <span class="exchange-part-label">{PART_LABEL[props.part.kind]}<Show when={name()}> · <span class="exchange-part-name">{shownText(name())}</span></Show></span>
    </Show>
    <Switch fallback={<PartText text={props.part.text} />}>
      <Match when={props.part.kind === 'media'}><span class="muted">{shownText(props.part.text)}</span></Match>
    </Switch>
  </div>;
}

/** Label for a paging button: the next step, and how many remain when more than one step is left. */
const moreLabel = (left: number, page: number) => (left > page ? `Show ${page} more of ${left}` : `Show ${left} more`);

/** One message; its parts page like the message list, so one message with thousands of parts can't stall a frame. */
function Message(props: { message: ExchangeMessage }) {
  const [limit, setLimit] = createSignal(PART_PAGE);
  const left = () => props.message.parts.length - limit();
  return <div class="exchange-message">
    <span class="exchange-role">{shownText(props.message.role)}</span>
    <For each={props.message.parts.slice(0, limit())}>{(part) => <Part part={part} />}</For>
    <Show when={left() > 0}><button class="exchange-more" type="button" onClick={() => setLimit((n) => n + PART_PAGE)}>{moreLabel(left(), PART_PAGE)}</button></Show>
  </div>;
}

function CutMark() {
  return <span class="exchange-cut">Recording stopped here at {LIMIT_TEXT}; the rest was not recorded.</span>;
}

/** One side of an exchange: readable messages when the body has a known shape, else (or on request) the raw text. */
export function ExchangeBody(props: { label: string; side: ExchangeSide; type: string; encoding: string }) {
  const [view, setView] = createSignal<View>('readable');
  const [messageLimit, setMessageLimit] = createSignal(MESSAGE_PAGE);
  const [rawLimit, setRawLimit] = createSignal(RENDER_CHUNK);
  const messages = () => props.side.messages ?? [];
  const readable = () => view() === 'readable' && messages().length > 0;
  const raw = createMemo(() => shownText(props.side.pretty ?? props.side.raw));
  return <section class="archive-body">
    <div class="archive-body-head">
      <span class="section-label">{props.label}</span>
      <span class="muted">{shownText([props.type, props.encoding].filter(Boolean).join(' · '))}</span>
      <Show when={props.side.cut}>
        <HoverTip title={`Cut at ${LIMIT_TEXT}`} rows={[]} note={CUT_NOTE}><span class="badge compact amber">Cut at {LIMIT_TEXT}</span></HoverTip>
      </Show>
      <Show when={messages().length > 0}><span class="archive-body-view"><Seg label={`${props.label} view`} value={view()} options={VIEWS} onChange={setView} /></span></Show>
    </div>
    <Show when={readable()} fallback={<>
      <pre>{raw().slice(0, rawLimit()) || 'No body stored.'}<Show when={props.side.cut && raw().length <= rawLimit()}><CutMark /></Show></pre>
      <Show when={raw().length > rawLimit()}><button class="btn ghost" type="button" onClick={() => setRawLimit((n) => n + RENDER_CHUNK)}>Show more</button></Show>
    </>}>
      <div class="exchange-messages">
        <For each={messages().slice(0, messageLimit())}>{(m) => <Message message={m} />}</For>
        <Show when={messages().length > messageLimit()}>
          <button class="btn ghost" type="button" onClick={() => setMessageLimit((n) => n + MESSAGE_PAGE)}>{moreLabel(messages().length - messageLimit(), MESSAGE_PAGE)}</button>
        </Show>
        <Show when={props.side.cut && messages().length <= messageLimit()}><CutMark /></Show>
      </div>
    </Show>
  </section>;
}
