import { createResource, createSignal, For, Show } from 'solid-js';
import type { ClientId, ClientSetupState, ClientSetupStatus } from '@shared/types';
import { Notice } from './ui';

const CLIENTS: { id: ClientId; label: string; help: string }[] = [
  { id: 'claude', label: 'Claude Code', help: 'Sets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in the env section of its settings.' },
  {
    id: 'codex',
    label: 'Codex',
    help: 'Adds a "spillway" model provider and makes it the default. Codex keeps the key in plain text there (experimental_bearer_token).',
  },
];

const STATE: Record<ClientSetupState, { label: string; tone: string; title: string }> = {
  'not-applied': { label: 'Not applied', tone: '', title: 'This client does not use the proxy through its config file.' },
  applied: { label: 'Applied', tone: 'green', title: 'The config file points at this proxy with the current key.' },
  'out-of-date': { label: 'Out of date', tone: 'amber', title: 'The port or key changed since it was applied. Re-apply to update it.' },
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

  return (
    <div>
      <For each={CLIENTS}>
        {(c) => {
          const s = () => status()?.find((x) => x.client === c.id);
          const state = () => STATE[s()?.state ?? 'not-applied'];
          return (
            <div class="setting-row">
              <div class="setting-text">
                <div class="setting-label row">
                  {c.label}
                  <span class={`badge ${state().tone}`} title={state().title}>{state().label}</span>
                </div>
                <div class="setting-help">{c.help}</div>
                <div class="setting-help mono">{s()?.path ?? ''}</div>
                <Show when={s()?.error}>
                  <div class="setting-help error">{s()!.error}</div>
                </Show>
              </div>
              <div class="setting-control">
                <button class="btn" classList={{ primary: s()?.state === 'out-of-date' }} disabled={busy() !== null || !s() || !!s()?.error} onClick={() => void act(c.id, window.api.applyClientSetup)}>
                  {s()?.state === 'not-applied' ? 'Apply' : 'Re-apply'}
                </button>
                <Show when={s() && s()!.state !== 'not-applied'}>
                  <button class="btn ghost" disabled={busy() !== null} title="Restore what this changed and remove the backup" onClick={() => void act(c.id, window.api.undoClientSetup)}>
                    Undo
                  </button>
                </Show>
              </div>
            </div>
          );
        }}
      </For>
      <Show when={error()}>
        <Notice tone="error">{error()}</Notice>
      </Show>
    </div>
  );
}
