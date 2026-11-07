import { createSignal, Show } from 'solid-js';
import { Select } from './ui';
import type { StoredActivityEvent } from '@shared/types';
import { proxyStatus, settings, snapshot } from '../store';

/** Moves a request's conversation to another enabled account of the same provider; hidden when nothing can move. */
export function MoveConversation(props: { e: StoredActivityEvent; account: (authIndex: string | null) => string }) {
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const targets = () =>
    (snapshot()?.credentials ?? []).filter((c) => c.provider === props.e.provider && !c.disabled && c.authIndex !== props.e.authIndex);
  const usable = () => !!props.e.sessionId && settings().proxy.sessionAffinity && targets().length > 0;

  const move = async (authIndex: string) => {
    const sessionId = props.e.sessionId;
    if (!sessionId) return;
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
      <Select class="move-conversation" label="Move conversation" placeholder="Move…"
        disabled={busy() || proxyStatus()?.state !== 'running'}
        title="Move this conversation and its subagents to another account. Its prompt cache starts over there."
        options={targets().map((c) => ({ value: c.authIndex, label: c.label }))} onChange={(v) => void move(v)} />
      <Show when={result()}>
        {(r) => <span class="truncate" classList={{ muted: r().ok, 'move-conversation-error': !r().ok }} title={r().text}>{r().text}</span>}
      </Show>
    </Show>
  );
}
