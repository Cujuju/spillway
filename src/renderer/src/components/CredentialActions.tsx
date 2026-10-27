import { Download, KeyRound, ListTree } from 'lucide-solid';
import { createResource, createSignal, For, Show } from 'solid-js';
import type { Credential, CredentialRenewResult } from '@shared/types';
import { familyName, groupModelFamilies } from '../lib/modelFamilies';
import { providerVar } from '../lib/providers';
import { Dialog, ProviderGlyph } from './ui';

const ICON_PX = 14;

/** One line for a renewal: what worked, then each failure with its reason. */
export function renewSummary(r: CredentialRenewResult): { ok: string | null; error: string | null } {
  const ok = r.renewed > 0 ? `Renewed ${r.renewed} ${r.renewed === 1 ? 'login' : 'logins'}.` : null;
  const error = r.failed.length ? `Renewal failed: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}` : null;
  return { ok, error };
}

/** Row actions on the Logins table: served models, token renewal and login-file export. */
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
  const renew = () => {
    const { id, label } = props.credential;
    const { onDone, onError } = props;
    return run(async () => {
      const s = renewSummary(await window.api.renewCredentials(id));
      if (s.error) onError(s.error);
      else if (s.ok) onDone(`${label}: login renewed.`);
    });
  };
  const exportFile = () => {
    const { id, label } = props.credential;
    const { onDone } = props;
    return run(async () => {
      const saved = await window.api.exportCredential(id);
      if (saved) onDone(`Saved ${label}'s login file to ${saved}. It holds the account's tokens; keep it private.`);
    });
  };

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
  const families = () => groupModelFamilies(models() ?? []);
  const count = () => models()?.length ?? 0;
  return (
    <Dialog title="Models" onClose={props.onClose} actions={<button class="btn" onClick={props.onClose}>Close</button>}>
      <Show when={!models.loading} fallback={<p class="muted">Loading…</p>}>
        <Show when={!models.error} fallback={<p class="secondary">Could not load models: {(models.error as Error).message}</p>}>
          <Show when={count()} fallback={<p class="muted">The proxy lists no models for this account. It may be disabled or not loaded yet.</p>}>
            <div class="dialog-sub model-families-sub">
              <ProviderGlyph provider={props.credential.provider} />
              <span>
                {props.credential.label} · {count()} {count() === 1 ? 'model' : 'models'}
              </span>
            </div>
            <ul class="model-families" style={{ '--card-wash-hue': providerVar(props.credential.provider) }}>
              <For each={families()}>
                {(f) => (
                  <li class="model-family card-wash">
                    <div class="model-family-head">
                      <span class="model-family-name">{familyName(f)}</span>
                      <Show when={f.latest.version.length}>
                        <span class="model-family-version">{f.latest.label}</span>
                      </Show>
                      <span class="model-family-id selectable">{f.latest.model.id}</span>
                    </div>
                    <Show when={f.older.length}>
                      <div class="model-family-older">
                        <For each={f.older}>
                          {(v) => (
                            <span class="badge selectable" title={v.model.id}>
                              {v.label}
                            </span>
                          )}
                        </For>
                      </div>
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
