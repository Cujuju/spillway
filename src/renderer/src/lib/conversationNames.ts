import { createSignal } from 'solid-js';

/** Clients rename conversations after they start, so a looked-up ID is asked again after this long. */
const NAME_REFRESH_MS = 5 * 60_000;
/** Shown for an unnamed conversation: enough of its ID to tell conversations apart. */
const SHORT_ID_CHARS = 8;
const AGENT_MARK = ':agent:';

const [names, setNames] = createSignal<ReadonlyMap<string, string>>(new Map());
const askedAt = new Map<string, number>();
let queued = new Set<string>();

function flush(): void {
  const ids = [...queued];
  queued = new Set();
  window.api.conversationNames(ids)
    .then((found) => setNames((cur) => new Map([...cur, ...Object.entries(found)])))
    .catch((err: unknown) => console.error('[activity] conversation names failed:', err));
}

/** The client's title for a proxy session ID, fetched in one batch per tick; null until known or when there is none. */
export function conversationName(sessionId: string): string | null {
  const at = askedAt.get(sessionId);
  if (at === undefined || Date.now() - at > NAME_REFRESH_MS) {
    askedAt.set(sessionId, Date.now());
    if (queued.size === 0) queueMicrotask(flush);
    queued.add(sessionId);
  }
  return names().get(sessionId) ?? null;
}

/** "claude:<uuid>:agent:<id>" → first characters of the conversation's own ID, marked when a subagent. */
export function shortConversationId(sessionId: string): string {
  const [conversation = sessionId, agent] = sessionId.split(AGENT_MARK);
  const id = conversation.slice(conversation.indexOf(':') + 1).slice(0, SHORT_ID_CHARS);
  return agent ? `${id} › agent` : id;
}

/** What a request's Conversation cell shows: the title when the client gave one, else the short ID. */
export function conversationLabel(sessionId: string | null): string {
  if (!sessionId) return '';
  const name = conversationName(sessionId);
  if (!name) return shortConversationId(sessionId);
  return sessionId.includes(AGENT_MARK) ? `${name} › agent` : name;
}
