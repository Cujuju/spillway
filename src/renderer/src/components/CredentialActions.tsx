import { Download, KeyRound, ListTree } from 'lucide-solid';
import { createResource, createSignal, For, Show } from 'solid-js';
import type { Credential, CredentialRenewResult } from '@shared/types';
import { Dialog } from './ui';

const ICON_PX = 14;

/** One line for a renewal: what worked, then each failure with its reason. */
export function renewSummary(r: CredentialRenewResult): { ok: string | null; error: string | null } {
  const ok = r.renewed > 0 ? `Renewed ${r.renewed} ${r.renewed === 1 ? 'login' : 'logins'}.` : null;
  const error = r.failed.length ? `Renewal failed: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}` : null;
  return { ok, error };
}

/** Row actions on the Accounts table: served models, token renewal and login-file export. */
export function CredentialActions(props: {
  credential: Credential;
  disabled: boolean;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [showModels, setShowModels] = createSignal(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const renew = () =>
    run(async () => {
      const s = renewSummary(await window.api.renewCredentials(props.credential.id));
      if (s.error) props.onError(s.error);
      else if (s.ok) props.onDone(`${props.credential.label}: login renewed.`);
    });
  const exportFile = () =>
    run(async () => {
      const saved = await window.api.exportCredential(props.credential.id);
      if (saved) props.onDone(`Saved ${props.credential.label}'s login file to ${saved}. It holds the account's tokens; keep it private.`);
    });

  return (
    <>
      <button class="btn ghost icon-btn" disabled={props.disabled} title="Models this account serves" onClick={() => setShowModels(true)}>
        <ListTree size={ICON_PX} />
      </button>
      <button class="btn ghost icon-btn" disabled={props.disabled || busy()} title="Renew login token now" onClick={() => void renew()}>
        <KeyRound size={ICON_PX} class={busy() ? 'spin' : undefined} />
      </button>
      <button class="btn ghost icon-btn" disabled={props.disabled || busy()} title="Export login file" onClick={() => void exportFile()}>
        <Download size={ICON_PX} />
      </button>
      <Show when={showModels()}>
        <ModelsDialog credential={props.credential} onClose={() => setShowModels(false)} />
      </Show>
    </>
  );
}

function ModelsDialog(props: { credential: Credential; onClose: () => void }) {
  const [models] = createResource(() => window.api.credentialModels(props.credential.id));
  return (
    <Dialog title={`Models · ${props.credential.label}`} onClose={props.onClose} actions={<button class="btn" onClick={props.onClose}>Close</button>}>
      <Show when={!models.loading} fallback={<p class="muted">Loading…</p>}>
        <Show when={!models.error} fallback={<p class="secondary">Could not load models: {(models.error as Error).message}</p>}>
          <Show when={models()?.length} fallback={<p class="muted">The proxy lists no models for this account. It may be disabled or not loaded yet.</p>}>
            <ul class="model-list">
              <For each={models()}>
                {(m) => (
                  <li>
                    <span class="selectable">{m.id}</span>
                    <Show when={m.displayName && m.displayName !== m.id}>
                      <span class="muted"> · {m.displayName}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </Dialog>
  );
}
