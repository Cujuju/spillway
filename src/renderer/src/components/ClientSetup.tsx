import { createResource, createSignal, For, Show } from 'solid-js';
import type { ClientId, ClientSetupState, ClientSetupStatus } from '@shared/types';
import { Notice } from './ui';

const CLIENTS: { id: ClientId; label: string; help: string }[] = [
  { id: 'claude', label: 'Claude Code', help: 'Writes the endpoint and key into its settings.' },
  { id: 'codex', label: 'Codex', help: 'Adds a default "spillway" provider. Codex asks Spillway for the key, so it is never written to its config.' },
];
/** Shared by every config client: Apply backs up the file first. */
const BACKUP_NOTE = 'Undo restores the backup.';

const STATE: Record<ClientSetupState, { label: string; tone: string; title: string }> = {
  'not-applied': { label: 'Not applied', tone: '', title: 'This client does not use the proxy through its config file.' },
  applied: { label: 'Applied', tone: 'green', title: 'The config file points at this proxy and gets the current key.' },
  'out-of-date': { label: 'Out of date', tone: 'amber', title: 'The port, key or app location changed since it was applied. Re-apply to update it.' },
};

/** Apply/Undo of the proxy endpoint and key in each client's own config file; main keeps a backup. */
export function ClientSetup(props: { endpoint: string; clientKey: string }) {
  // Re-read whenever the endpoint or key changes, so a port change or new key shows as out of date.
  const [status, { mutate }] = createResource(
    () => (props.endpoint && props.clientKey ? `${props.endpoint} ${props.clientKey}` : false),
    () => window.api.clientSetupStatus(),
  );
  const [busy, setBusy] = createSignal<ClientId | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const act = async (client: ClientId, fn: (c: ClientId) => Promise<ClientSetupStatus[]>) => {
    setBusy(client);
    setError(null);
    try {
      mutate(await fn(client));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // A fragment, so these rows share the parent list's dividers.
  return (
    <>
      <For each={CLIENTS}>
        {(c) => {
          const s = () => status()?.find((x) => x.client === c.id);
          const state = () => STATE[s()?.state ?? 'not-applied'];
          return (
            <div class="list-row">
              <div class="list-row-text">
                <div class="list-row-label">
                  {c.label}
                  <span class={`badge ${state().tone}`} title={state().title}>{state().label}</span>
                </div>
                <div class="list-row-help">{c.help} {BACKUP_NOTE}</div>
                <div class="list-row-help path">{s()?.path ?? ''}</div>
                <Show when={s()?.error}>
                  <div class="list-row-help error">{s()!.error}</div>
                </Show>
              </div>
              <div class="list-row-actions">
                <Show when={s() && s()!.state !== 'not-applied'}>
                  <button class="btn ghost" disabled={busy() !== null} title="Restore what this changed and remove the backup" onClick={() => void act(c.id, window.api.undoClientSetup)}>
                    Undo
                  </button>
                </Show>
                <button class="btn main-action" classList={{ primary: s()?.state === 'out-of-date' }} disabled={busy() !== null || !s() || !!s()?.error} onClick={() => void act(c.id, window.api.applyClientSetup)}>
                  {s()?.state === 'not-applied' ? 'Apply' : 'Re-apply'}
                </button>
              </div>
            </div>
          );
        }}
      </For>
      <Show when={error()}>
        <Notice tone="error">{error()}</Notice>
      </Show>
    </>
  );
}
