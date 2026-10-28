import { createSignal, For, Show } from 'solid-js';
import type { StoredActivityEvent } from '@shared/types';
import { proxyStatus, settings, snapshot } from '../store';

/** The select's resting value: no account chosen. */
const NO_TARGET = '';

/** Moves a request's conversation to another enabled account of the same provider; hidden when nothing can move. */
export function MoveConversation(props: { e: StoredActivityEvent; account: (authIndex: string | null) => string }) {
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const targets = () =>
    (snapshot()?.credentials ?? []).filter((c) => c.provider === props.e.provider && !c.disabled && c.authIndex !== props.e.authIndex);
  const usable = () => !!props.e.sessionId && settings().proxy.sessionAffinity && targets().length > 0;

  const move = async (select: HTMLSelectElement) => {
    const authIndex = select.value;
    select.value = NO_TARGET;
    const sessionId = props.e.sessionId;
    if (!sessionId || authIndex === NO_TARGET) return;
    setBusy(true);
    try {
      await window.api.moveConversation(sessionId, authIndex);
      setResult({ ok: true, text: `Moved to ${props.account(authIndex)}` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={usable()}>
      <select
        class="select move-conversation"
        value={NO_TARGET}
        disabled={busy() || proxyStatus()?.state !== 'running'}
        title="Move this conversation and its subagents to another account. Its prompt cache starts over there."
        onChange={(ev) => void move(ev.currentTarget)}
      >
        <option value={NO_TARGET} disabled>Move…</option>
        <For each={targets()}>{(c) => <option value={c.authIndex}>{c.label}</option>}</For>
      </select>
      <Show when={result()}>
        {(r) => <span class="truncate" classList={{ muted: r().ok, 'move-conversation-error': !r().ok }} title={r().text}>{r().text}</span>}
      </Show>
    </Show>
  );
}
