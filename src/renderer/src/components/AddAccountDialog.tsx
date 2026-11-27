import { CheckCircle2, ExternalLink, LoaderCircle } from '@/lib/icons';
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { Credential, OAuthStart } from '@shared/types';
import { providerLabel } from '@shared/trayValues';
import { OAUTH_PROVIDERS } from '../lib/providers';
import { CopyButton, Dialog, Notice, ProviderGlyph } from './ui';

/** Matches the dashboard's own "is it done yet" cadence without hammering the proxy. */
const POLL_MS = 1_500;
/** The proxy expires OAuth sessions after 5 minutes; stop polling just after it would. */
const SESSION_TIMEOUT_MS = 5 * 60_000 + 10_000;
const ICON_PX = 16;

type Step =
  | { kind: 'pick' }
  | { kind: 'starting'; provider: string }
  | { kind: 'waiting'; provider: string; session: OAuthStart }
  | { kind: 'done'; provider: string }
  | { kind: 'error'; provider: string | null; message: string };

const labelOf = (id: string | null) => OAUTH_PROVIDERS.find((p) => p.id === id)?.label ?? providerLabel(id ?? '');
/** Provider picker → sign-in link → poll until saved. `target` skips the picker and signs that login in again. */
export function AddAccountDialog(props: { target?: Credential; onClose: () => void }) {
  const [step, setStep] = createSignal<Step>({ kind: 'pick' });
  let timer: ReturnType<typeof setInterval> | undefined;
  let deadline = 0;

  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const cancelSession = () => {
    const s = step();
    stopPolling();
    if (s.kind === 'waiting') void window.api.oauthCancel(s.session.state).catch(() => undefined);
  };
  onCleanup(cancelSession);

  const poll = async (provider: string, session: OAuthStart) => {
    if (Date.now() > deadline) {
      cancelSession();
      setStep({ kind: 'error', provider, message: 'Sign-in timed out. Start again when ready.' });
      return;
    }
    try {
      const r = await window.api.oauthStatus(session.state);
      if (step().kind !== 'waiting') return;
      if (r.status === 'ok') {
        stopPolling();
        setStep({ kind: 'done', provider });
      } else if (r.status === 'error') {
        stopPolling();
        setStep({ kind: 'error', provider, message: r.error });
      }
    } catch (e) {
      stopPolling();
      setStep({ kind: 'error', provider, message: (e as Error).message });
    }
  };

  const start = async (provider: string) => {
    setStep({ kind: 'starting', provider });
    try {
      const target = props.target;
      const session = await window.api.oauthStart(target ? { credentialId: target.id } : { provider });
      setStep({ kind: 'waiting', provider, session });
      deadline = Date.now() + SESSION_TIMEOUT_MS;
      timer = setInterval(() => void poll(provider, session), POLL_MS);
    } catch (e) {
      setStep({ kind: 'error', provider, message: (e as Error).message });
    }
  };

  const restart = () => {
    const target = props.target;
    if (target) void start(target.provider);
    else setStep({ kind: 'pick' });
  };
  onMount(() => { if (props.target) restart(); });

  const close = () => {
    cancelSession();
    props.onClose();
  };
  const waiting = () => {
    const s = step();
    return s.kind === 'waiting' ? s : null;
  };

  return (
    <Dialog
      title={props.target ? 'Sign in again' : 'Add account'}
      onClose={close}
      actions={
        <Switch fallback={<button class="btn" onClick={close}>Cancel</button>}>
          <Match when={step().kind === 'done'}>
            <Show when={!props.target}>
              <button class="btn" onClick={() => setStep({ kind: 'pick' })}>Add another</button>
            </Show>
            <button class="btn primary" onClick={props.onClose}>Done</button>
          </Match>
          <Match when={step().kind === 'error'}>
            <button class="btn" onClick={close}>Close</button>
            <button class="btn primary" onClick={restart}>Try again</button>
          </Match>
        </Switch>
      }
    >
      <Switch>
        <Match when={step().kind === 'pick'}>
          <p class="secondary">Pick a provider, then sign in with its link; the proxy stores the login.</p>
          <div class="provider-grid">
            <For each={OAUTH_PROVIDERS}>
              {(p) => (
                <button class="provider-card" onClick={() => void start(p.id)}>
                  <ProviderGlyph provider={p.id} size="lg" />
                  <span>
                    <strong>{p.label}</strong>
                    <span class="muted">{p.hint}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Match>
        <Match when={step().kind === 'starting'}>
          <div class="oauth-wait">
            <LoaderCircle size={ICON_PX} class="spin" /> Starting {labelOf((step() as { provider: string }).provider)} sign-in…
          </div>
        </Match>
        <Match when={waiting()}>
          {(w) => (
            <>
              <Show
                when={props.target}
                fallback={
                  <p>
                    Open the {labelOf(w().provider)} sign-in link in your browser. Adding another account? A browser signed in to {labelOf(w().provider)}{' '}
                    signs in as that account again, so copy the link into a private window, or sign out first.
                  </p>
                }
              >
                {(t) => (
                  <p>
                    Open the {labelOf(w().provider)} sign-in link and sign in as <strong>{t().email ?? t().label}</strong>. The proxy replaces this login's
                    tokens and keeps its settings; another account is refused. If your browser is signed in to a different account, use a private window.
                  </p>
                )}
              </Show>
              <div class="row">
                <CopyButton value={w().session.url} what="link" label="Copy link" />
                <button class="btn primary" onClick={() => void window.api.openExternal(w().session.url)}>
                  <ExternalLink size={14} /> Open in browser
                </button>
              </div>
              <div class="oauth-wait">
                <LoaderCircle size={ICON_PX} class="spin" /> Waiting for you to finish signing in to {labelOf(w().provider)}…
              </div>
            </>
          )}
        </Match>
        <Match when={step().kind === 'done'}>
          <div class="oauth-wait" style={{ color: 'var(--color-green)' }}>
            <CheckCircle2 size={ICON_PX} />{' '}
            {props.target ? `${props.target.label} signed in again.` : `${labelOf((step() as { provider: string }).provider)} account added.`} Its limits are
            being looked up.
          </div>
        </Match>
        <Match when={step().kind === 'error'}>
          <Notice tone="error">{(step() as { message: string }).message}</Notice>
        </Match>
      </Switch>
    </Dialog>
  );
}
