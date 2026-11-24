import { Download, KeyRound, ListTree, LogIn } from 'lucide-solid';
import { createResource, createSignal, Show } from 'solid-js';
import type { Credential, CredentialRenewResult } from '@shared/types';
import { ModelFamilyList } from './ModelFamilyList';
import { Dialog, ProviderGlyph } from './ui';

const ICON_PX = 14;

/** One line for a renewal: what worked, then each failure with its reason; `failedNames` are the auth files to sign in again. */
export function renewSummary(r: CredentialRenewResult): { ok: string | null; error: string | null; failedNames: string[] } {
  const ok = r.renewed > 0 ? `Renewed ${r.renewed} ${r.renewed === 1 ? 'login' : 'logins'}.` : null;
  const error = r.failed.length ? `Renewal failed: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}` : null;
  return { ok, error, failedNames: r.failed.map((f) => f.name) };
}

/** Row actions on the Logins table: served models, token renewal, sign-in again and login-file export. */
export function CredentialActions(props: {
  credential: Credential;
  disabled: boolean;
  onDone: (message: string) => void;
  /** `signIn` lists auth files whose renewal failed, so the caller can offer a fresh sign-in. */
  onError: (message: string, signIn?: string[]) => void;
  onSignIn: () => void;
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
      if (s.error) onError(s.error, s.failedNames);
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
      <button class="btn ghost icon-btn" disabled={props.disabled} title="Sign in again (replaces this login's tokens)" onClick={() => props.onSignIn()}>
        <LogIn size={ICON_PX} />
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
  const count = () => models()?.length ?? 0;
  return (
    <Dialog title="Models" onClose={props.onClose} actions={<button class="btn" onClick={props.onClose}>Close</button>}>
      <Show when={!models.loading} fallback={<p class="muted">Loading…</p>}>
        <Show when={!models.error} fallback={<p class="secondary">Could not load models: {(models.error as Error).message}</p>}>
          <Show when={count()} fallback={<p class="muted">The proxy lists no models for this account. It may be disabled or not loaded yet.</p>}>
            <div class="dialog-sub">
              <ProviderGlyph provider={props.credential.provider} />
              <span class="dialog-sub-text">
                {props.credential.label} · {count()} {count() === 1 ? 'model' : 'models'}
              </span>
            </div>
            <ModelFamilyList models={models() ?? []} provider={props.credential.provider} />
          </Show>
        </Show>
      </Show>
    </Dialog>
  );
}
