import { CheckCircle2, ExternalLink, LoaderCircle } from 'lucide-solid';
import { createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js';
import type { OAuthStart } from '@shared/types';
import { OAUTH_PROVIDERS } from '../lib/providers';
import { snapshot } from '../store';
import { CopyButton, Dialog, Notice, ProviderGlyph } from './ui';

/** Matches the dashboard's own "is it done yet" cadence without hammering the proxy. */
const POLL_MS = 1_500;
/** The proxy expires OAuth sessions after 5 minutes; stop polling just after it would. */
const SESSION_TIMEOUT_MS = 5 * 60_000 + 10_000;
const ICON_PX = 16;

type Step =
  | { kind: 'pick' }
  | { kind: 'starting'; provider: string }
  /** opened: false when the provider already has an account, so the link isn't sent to the browser signed in to it. */
  | { kind: 'waiting'; provider: string; session: OAuthStart; opened: boolean }
  | { kind: 'done'; provider: string }
  | { kind: 'error'; provider: string | null; message: string };

const labelOf = (id: string | null) => OAUTH_PROVIDERS.find((p) => p.id === id)?.label ?? id ?? '';
/** A subscription login the proxy already holds for this provider. */
const hasAccount = (provider: string) => (snapshot()?.credentials ?? []).some((c) => !c.apiKey && c.provider === provider);

/** Provider picker → browser sign-in → poll until the proxy saves the credential. */
export function AddAccountDialog(props: { onClose: () => void }) {
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
      const session = await window.api.oauthStart(provider);
      const opened = !hasAccount(provider);
      if (opened) await window.api.openExternal(session.url);
      setStep({ kind: 'waiting', provider, session, opened });
      deadline = Date.now() + SESSION_TIMEOUT_MS;
      timer = setInterval(() => void poll(provider, session), POLL_MS);
    } catch (e) {
      setStep({ kind: 'error', provider, message: (e as Error).message });
    }
  };

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
      title="Add account"
      onClose={close}
      actions={
        <Switch fallback={<button class="btn" onClick={close}>Cancel</button>}>
          <Match when={step().kind === 'done'}>
            <button class="btn" onClick={() => setStep({ kind: 'pick' })}>Add another</button>
            <button class="btn primary" onClick={props.onClose}>Done</button>
          </Match>
          <Match when={step().kind === 'error'}>
            <button class="btn" onClick={close}>Close</button>
            <button class="btn primary" onClick={() => setStep({ kind: 'pick' })}>Try again</button>
          </Match>
        </Switch>
      }
    >
      <Switch>
        <Match when={step().kind === 'pick'}>
          <p class="secondary">Pick a provider. Its sign-in page opens in your browser; the proxy stores the login.</p>
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
            <LoaderCircle size={ICON_PX} class="spin" /> Opening {labelOf((step() as { provider: string }).provider)} sign-in…
          </div>
        </Match>
        <Match when={waiting()}>
          {(w) => (
            <>
              <Show
                when={w().opened}
                fallback={
                  <p>
                    You already have a {labelOf(w().provider)} account here. A browser signed in to it signs in as that account again, so copy
                    the link into a private window, or sign out of {labelOf(w().provider)} in your browser first.
                  </p>
                }
              >
                <p class="muted">
                  Signed in to another {labelOf(w().provider)} account in this browser? The page signs in as that one. Copy the link into a
                  private window, or sign out first.
                </p>
              </Show>
              <div class="row">
                <CopyButton ghost={w().opened} primary={!w().opened} value={w().session.url} what="link" label="Copy link" />
                <button class="btn" onClick={() => void window.api.openExternal(w().session.url)}>
                  <ExternalLink size={14} /> {w().opened ? 'Open again' : 'Open in browser'}
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
            <CheckCircle2 size={ICON_PX} /> {labelOf((step() as { provider: string }).provider)} account added. Its limits are being looked up.
          </div>
        </Match>
        <Match when={step().kind === 'error'}>
          <Notice tone="error">{(step() as { message: string }).message}</Notice>
        </Match>
      </Switch>
    </Dialog>
  );
}
