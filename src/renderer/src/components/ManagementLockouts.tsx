import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { ManagementLockout } from '@shared/types';

/** A new failure or lockout shows up within this long while the page is open. */
const LOCKOUT_POLL_MS = 10_000;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function describe(l: ManagementLockout): string {
  if (l.lockedUntil) return `${l.ip}: locked out until ${timeOf(l.lockedUntil)}`;
  return `${l.ip}: ${l.failures} of ${l.failuresAllowed} wrong keys before a lockout`;
}

/** Outside tools locked out of the management API by wrong keys, with a reset. Spillway itself is exempt. */
export function ManagementLockouts() {
  const [list, setList] = createSignal<ManagementLockout[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const run = async (fn: () => Promise<ManagementLockout[]>) => {
    try {
      setList(await fn());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  onMount(() => {
    void run(() => window.api.managementLockouts());
    const timer = setInterval(() => void run(() => window.api.managementLockouts()), LOCKOUT_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });
  const reset = async () => {
    setBusy(true);
    await run(() => window.api.resetManagementLockouts());
    setBusy(false);
  };
  const locked = () => list().some((l) => l.lockedUntil);

  return (
    <div class="list-row">
      <div class="list-row-text">
        <div class="list-row-label">
          Management lockouts
          <Show when={list().length}>
            <span class={`badge ${locked() ? 'red' : 'amber'}`}>{locked() ? 'Locked out' : 'Wrong keys'}</span>
          </Show>
        </div>
        <div class="list-row-help">Tools that send wrong management keys (such as T3 Code's usage hub) are locked out for a while. Spillway itself never is.</div>
        <Show when={list().length} fallback={<div class="list-row-help">None.</div>}>
          <For each={list()}>{(l) => <div class="list-row-help">{describe(l)}</div>}</For>
        </Show>
        <Show when={error()}>
          <div class="list-row-help error">{error()}</div>
        </Show>
      </div>
      <div class="list-row-actions">
        <button class="btn" disabled={busy() || !list().length} title="Lift every lockout and forget failed keys" onClick={() => void reset()}>
          Reset
        </button>
      </div>
    </div>
  );
}
